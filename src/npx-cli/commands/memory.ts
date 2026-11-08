import { readFileSync } from 'node:fs';
import { buildServerContext, type ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { ServerClientError } from '../../services/hooks/server-client.js';
import {
  describeUnusableProject,
  resolveFolderProject,
  type FolderProjectResolution,
  type UnusableFolderProject,
} from '../../services/identity/folder-project.js';
import { buildUserNoteRequest } from '../../services/retrieval/user-note-write.js';
import { actorField, actorsOf, configuredActor, defaultActorSource, parseActor, type ActorSource } from '../../shared/actor.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  clampLimit,
  formatObservationDetails,
  formatObservationIndex,
  GET_MAX_IDS,
  indexSummary,
  observationDate,
  observationTitle,
  observationType,
  SEARCH_LIMIT,
  type ObservationRow,
} from '../../shared/observation-format.js';

export interface MemoryCommandDeps {
  cwd: string;
  resolveContext: (cwd: string) => Pick<ServerRuntimeContext, 'client' | 'projectId'> | null;
  diagnose?: (cwd: string) => FolderProjectResolution;
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin?: () => Promise<string>;
  access?: () => string | undefined;
  actorSource?: ActorSource;
}

export function defaultMemoryCommandDeps(): MemoryCommandDeps {
  return {
    cwd: process.env.MEMSMITH_PROJECT_CWD || process.cwd(),
    resolveContext: (cwd) => buildServerContext({ cwd }),
    diagnose: (cwd) => resolveFolderProject(cwd),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readStdin: readAllStdin,
    access: configuredAccess,
    actorSource: defaultActorSource,
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function configuredAccess(): string | undefined {
  if (process.env.MEMSMITH_ACCESS !== undefined) return process.env.MEMSMITH_ACCESS;
  try {
    const value = (JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8').replace(/^﻿/, '')) as Record<string, unknown>).MEMSMITH_ACCESS;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export const READ_ONLY_REFUSAL = 'MemSmith is in read-only mode for this session (MEMSMITH_ACCESS=read). Nothing was saved.';

const GET_HINT = 'memsmith get <id> [<id>...]';
const SEARCH_USAGE = 'Usage: memsmith search [--json] [--actor <name>] [--limit <n>] [--] <query>';
const GET_USAGE = 'Usage: memsmith get [--json] [--] <id> [<id>...]';
const NOTE_USAGE = 'Usage: memsmith note [--json] [--] <text>   (use - to read the text from stdin)';
const NOT_SEARCHED = 'Memory was not searched; this is not an empty result.';
const NOT_SAVED = 'Nothing was saved.';

type ErrorCode =
  | 'usage'
  | 'invalid_actor'
  | 'no_project'
  | 'read_only'
  | 'server_unreachable'
  | 'server_timeout'
  | 'auth_failed'
  | 'request_failed';

class CommandFailure extends Error {
  constructor(readonly code: ErrorCode, readonly lines: string[]) {
    super(lines.join('\n'));
  }
}

type Reporter = {
  fail: (failure: CommandFailure) => number;
  print: (text: string, payload: unknown) => void;
};

function reporter(d: MemoryCommandDeps, json: boolean): Reporter {
  return {
    fail: (failure) => {
      if (json) d.out(JSON.stringify({ error: { code: failure.code, message: failure.lines.join('\n') } }, null, 2));
      else for (const line of failure.lines) d.err(line);
      return 1;
    },
    print: (text, payload) => d.out(json ? JSON.stringify(payload, null, 2) : text),
  };
}

interface ParsedArgs {
  json: boolean;
  actor?: string;
  limit?: number;
  words: string[];
  failure?: CommandFailure;
}

// Errors are collected rather than thrown so a --json later in the line still
// decides how the first error is printed.
function parseArgs(args: string[], allowed: { actor?: boolean; limit?: boolean }, usage: string): ParsedArgs {
  const parsed: ParsedArgs = { json: false, words: [] };
  const failure = (line: string) => new CommandFailure('usage', [line, usage]);
  const deferred: CommandFailure[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      parsed.words.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      parsed.words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === '--json' && inline === undefined) {
      parsed.json = true;
      continue;
    }
    if ((name === '--limit' && allowed.limit) || (name === '--actor' && allowed.actor)) {
      const value = inline ?? args[++i];
      if (name === '--limit') {
        if (!/^[1-9]\d*$/.test(value ?? '')) {
          deferred.push(failure(`--limit needs a positive whole number (got ${value === undefined ? 'nothing' : `"${value}"`}).`));
          continue;
        }
        parsed.limit = Number(value);
        continue;
      }
      const actor = parseActor(value ?? '');
      if (!actor.ok || !actor.actor) {
        deferred.push(new CommandFailure('invalid_actor', [
          `--actor needs a name: ${actor.ok ? 'got nothing' : actor.reason}.`,
          usage,
        ]));
        continue;
      }
      parsed.actor = actor.actor;
      continue;
    }
    deferred.push(failure(`Unknown option ${name}. To pass text that starts with --, put -- before it.`));
  }
  parsed.failure = deferred[0];
  return parsed;
}

function contextOrFail(d: MemoryCommandDeps, consequence: string, hint: string): Pick<ServerRuntimeContext, 'client' | 'projectId'> {
  const ctx = d.resolveContext(d.cwd);
  if (ctx) return ctx;
  const diagnosed = d.diagnose?.(d.cwd);
  const resolution: UnusableFolderProject = diagnosed && diagnosed.kind !== 'resolved'
    ? diagnosed
    : { kind: 'no_project', folder: d.cwd };
  throw new CommandFailure('no_project', describeUnusableProject(resolution, consequence, hint));
}

function requestFailure(error: unknown): CommandFailure {
  if (error instanceof CommandFailure) return error;
  if (error instanceof ServerClientError) {
    if (error.kind === 'transport') {
      return new CommandFailure('server_unreachable', ['The MemSmith server is not reachable. Start it with: memsmith start']);
    }
    if (error.kind === 'timeout') {
      return new CommandFailure('server_timeout', ['The MemSmith server did not answer in time. Try again, or check memsmith status.']);
    }
    if (error.status === 401 || error.status === 403) {
      return new CommandFailure('auth_failed', [
        `MemSmith refused the request: authentication error (HTTP ${error.status}).`,
        'Re-run the installer to refresh credentials: npx memsmith install',
      ]);
    }
  }
  return new CommandFailure('request_failed', [`Request failed: ${error instanceof Error ? error.message : String(error)}`]);
}

function singleActor(row: ObservationRow): string | null {
  const actor = row.metadata?.actor;
  return typeof actor === 'string' && actor.length > 0 ? actor : null;
}

function supersededBy(row: ObservationRow): string | null {
  return typeof row.supersededBy === 'string' && row.supersededBy ? row.supersededBy : null;
}

function searchResult(row: ObservationRow) {
  const { title, snippet } = indexSummary(row);
  return {
    id: row.id,
    date: observationDate(row),
    type: observationType(row),
    title,
    snippet,
    actor: singleActor(row),
    actors: actorsOf(row),
    supersededBy: supersededBy(row),
  };
}

function fullRecord(row: ObservationRow) {
  return {
    id: row.id,
    date: observationDate(row),
    type: observationType(row),
    kind: row.kind ?? null,
    lifecycleState: row.lifecycleState ?? null,
    title: observationTitle(row),
    content: typeof row.content === 'string' ? row.content : '',
    actor: singleActor(row),
    actors: actorsOf(row),
    supersededBy: supersededBy(row),
    createdAtEpoch: row.createdAtEpoch ?? null,
    updatedAtEpoch: typeof row.updatedAtEpoch === 'number' ? row.updatedAtEpoch : null,
    metadata: row.metadata ?? {},
  };
}

export async function runMemorySearch(args: string[], d: MemoryCommandDeps = defaultMemoryCommandDeps()): Promise<number> {
  const parsed = parseArgs(args, { actor: true, limit: true }, SEARCH_USAGE);
  const report = reporter(d, parsed.json);
  if (parsed.failure) return report.fail(parsed.failure);
  const query = parsed.words.join(' ').trim();
  if (!query && !parsed.actor) return report.fail(new CommandFailure('usage', [SEARCH_USAGE]));
  try {
    const ctx = contextOrFail(d, NOT_SEARCHED, 'Run this from a project folder where MemSmith has recorded a session.');
    const response = await ctx.client.searchObservations({
      projectId: ctx.projectId,
      query,
      limit: clampLimit(parsed.limit, SEARCH_LIMIT),
      ...(parsed.actor ? { actor: parsed.actor } : {}),
    });
    const rows = (response.observations ?? []) as ObservationRow[];
    const text = formatObservationIndex(rows, { query, getTool: GET_HINT, actor: parsed.actor });
    report.print(text.replace(`${GET_HINT}(ids=[...])`, GET_HINT), {
      project: { id: ctx.projectId, folder: d.cwd },
      query,
      actor: parsed.actor ?? null,
      results: rows.map(searchResult),
    });
    return 0;
  } catch (error) {
    return report.fail(requestFailure(error));
  }
}

export async function runMemoryGet(args: string[], d: MemoryCommandDeps = defaultMemoryCommandDeps()): Promise<number> {
  const parsed = parseArgs(args, {}, GET_USAGE);
  const report = reporter(d, parsed.json);
  if (parsed.failure) return report.fail(parsed.failure);
  const wanted = [...new Set(parsed.words.flatMap((id) => id.split(',')).map((id) => id.trim()).filter(Boolean))];
  if (wanted.length === 0) return report.fail(new CommandFailure('usage', [GET_USAGE]));
  if (wanted.length > GET_MAX_IDS) {
    return report.fail(new CommandFailure('usage', [`memsmith get takes at most ${GET_MAX_IDS} ids at a time (got ${wanted.length}).`]));
  }
  try {
    const ctx = contextOrFail(d, NOT_SEARCHED, 'Run this from a project folder where MemSmith has recorded a session.');
    const response = await ctx.client.getObservations({ projectId: ctx.projectId, ids: wanted });
    const rows = (response.observations ?? []) as ObservationRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found = wanted.filter((id) => byId.has(id));
    report.print(formatObservationDetails(rows, wanted), {
      project: { id: ctx.projectId, folder: d.cwd },
      results: found.map((id) => fullRecord(byId.get(id)!)),
      notFound: wanted.filter((id) => !byId.has(id)),
    });
    return found.length > 0 ? 0 : 1;
  } catch (error) {
    return report.fail(requestFailure(error));
  }
}

export async function runMemoryNote(args: string[], d: MemoryCommandDeps = defaultMemoryCommandDeps()): Promise<number> {
  const parsed = parseArgs(args, {}, NOTE_USAGE);
  const report = reporter(d, parsed.json);
  if (parsed.failure) return report.fail(parsed.failure);
  if ((d.access?.() ?? '').trim().toLowerCase() === 'read') {
    return report.fail(new CommandFailure('read_only', [READ_ONLY_REFUSAL]));
  }
  try {
    const fromStdin = parsed.words.length === 1 && parsed.words[0] === '-';
    const text = (fromStdin ? await (d.readStdin ?? readAllStdin)() : parsed.words.join(' ')).trim();
    if (!text) return report.fail(new CommandFailure('usage', [NOTE_USAGE]));
    const actor = configuredActor(d.actorSource ?? defaultActorSource);
    if (!actor.ok) {
      return report.fail(new CommandFailure('invalid_actor', [`MEMSMITH_ACTOR is not usable: ${actor.reason}. ${NOT_SAVED}`]));
    }
    const ctx = contextOrFail(d, NOT_SAVED, 'Run this from a project folder where MemSmith has recorded a session, or set MEMSMITH_PROJECT_CWD.');
    const request = buildUserNoteRequest(text, {
      projectId: ctx.projectId,
      ...(actor.actor ? { metadata: actorField(actor.actor) } : {}),
    });
    const { memory } = await ctx.client.addObservation(request);
    report.print(
      `Saved note ${memory.id} to project ${ctx.projectId}${actor.actor ? ` as ${actor.actor}` : ''}.`,
      {
        project: { id: ctx.projectId, folder: d.cwd },
        note: {
          id: memory.id,
          content: typeof memory.content === 'string' ? memory.content : text,
          actor: actor.actor,
          createdAtEpoch: typeof memory.createdAtEpoch === 'number' ? memory.createdAtEpoch : null,
        },
      },
    );
    return 0;
  } catch (error) {
    return report.fail(requestFailure(error));
  }
}
