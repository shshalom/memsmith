import { buildServerContext, type ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { ServerClientError } from '../../services/hooks/server-client.js';
import {
  describeUnusableProject,
  resolveFolderProject,
  type FolderProjectResolution,
} from '../../services/identity/folder-project.js';
import {
  clampLimit,
  formatObservationDetails,
  formatObservationIndex,
  GET_MAX_IDS,
  SEARCH_LIMIT,
} from '../../shared/observation-format.js';

export interface MemoryCommandDeps {
  cwd: string;
  resolveContext: (cwd: string) => Pick<ServerRuntimeContext, 'client' | 'projectId'> | null;
  diagnose?: (cwd: string) => FolderProjectResolution;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function defaultMemoryCommandDeps(): MemoryCommandDeps {
  return {
    cwd: process.env.MEMSMITH_PROJECT_CWD || process.cwd(),
    resolveContext: (cwd) => buildServerContext({ cwd }),
    diagnose: (cwd) => resolveFolderProject(cwd),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

const GET_HINT = 'memsmith get <id> [<id>...]';

function contextOrReport(d: MemoryCommandDeps): Pick<ServerRuntimeContext, 'client' | 'projectId'> | null {
  const ctx = d.resolveContext(d.cwd);
  if (!ctx) {
    const resolution = d.diagnose?.(d.cwd) ?? { kind: 'no_project', folder: d.cwd };
    const lines = describeUnusableProject(
      resolution.kind === 'no_key' ? resolution : { kind: 'no_project', folder: d.cwd },
      'Memory was not searched; this is not an empty result.',
      'Run this from a project folder where MemSmith has recorded a session.',
    );
    for (const line of lines ?? []) d.err(line);
  }
  return ctx;
}

function reportFailure(error: unknown, d: MemoryCommandDeps): number {
  if (error instanceof ServerClientError) {
    if (error.kind === 'transport') {
      d.err('The MemSmith server is not reachable. Start it with: memsmith start');
      return 1;
    }
    if (error.kind === 'timeout') {
      d.err('The MemSmith server did not answer in time. Try again, or check memsmith status.');
      return 1;
    }
    if (error.status === 401 || error.status === 403) {
      d.err(`MemSmith refused the request: authentication error (HTTP ${error.status}).`);
      d.err('Re-run the installer to refresh credentials: npx memsmith install');
      return 1;
    }
  }
  d.err(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

const SEARCH_USAGE = 'Usage: memsmith search <query> [--limit <n>]';

export async function runMemorySearch(args: string[], d: MemoryCommandDeps = defaultMemoryCommandDeps()): Promise<number> {
  const words: string[] = [];
  let rawLimit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--limit' && !arg.startsWith('--limit=')) {
      words.push(arg);
      continue;
    }
    const value = arg === '--limit' ? args[++i] : arg.slice('--limit='.length);
    if (!/^[1-9]\d*$/.test(value ?? '')) {
      d.err(`--limit needs a positive whole number (got ${value === undefined ? 'nothing' : `"${value}"`}).`);
      d.err(SEARCH_USAGE);
      return 1;
    }
    rawLimit = Number(value);
  }
  const query = words.join(' ').trim();
  if (!query) {
    d.err(SEARCH_USAGE);
    return 1;
  }
  const ctx = contextOrReport(d);
  if (!ctx) return 1;
  try {
    const response = await ctx.client.searchObservations({
      projectId: ctx.projectId,
      query,
      limit: clampLimit(rawLimit, SEARCH_LIMIT),
    });
    const text = formatObservationIndex(response.observations ?? [], { query, getTool: GET_HINT });
    d.out(text.replace(`${GET_HINT}(ids=[...])`, GET_HINT));
    return 0;
  } catch (error) {
    return reportFailure(error, d);
  }
}

export async function runMemoryGet(ids: string[], d: MemoryCommandDeps = defaultMemoryCommandDeps()): Promise<number> {
  const wanted = [...new Set(ids.flatMap((id) => id.split(',')).map((id) => id.trim()).filter(Boolean))];
  if (wanted.length === 0) {
    d.err('Usage: memsmith get <id> [<id>...]');
    return 1;
  }
  if (wanted.length > GET_MAX_IDS) {
    d.err(`memsmith get takes at most ${GET_MAX_IDS} ids at a time (got ${wanted.length}).`);
    return 1;
  }
  const ctx = contextOrReport(d);
  if (!ctx) return 1;
  try {
    const response = await ctx.client.getObservations({ projectId: ctx.projectId, ids: wanted });
    const rows = response.observations ?? [];
    d.out(formatObservationDetails(rows, wanted));
    return rows.some((row) => wanted.includes(row.id)) ? 0 : 1;
  } catch (error) {
    return reportFailure(error, d);
  }
}
