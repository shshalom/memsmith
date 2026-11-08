import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { CredentialStore } from '../../services/identity/credential-store.js';
import { ensureLocalTeamId, readLocalTeamId } from '../../services/identity/local-team.js';
import {
  readMarkerAt,
  writeMarkerAt,
  type ProjectMarker,
} from '../../services/identity/project-identity.js';
import {
  defaultResolutionEnv,
  findGitRoot,
  gitInfoExcludePath,
  resolveProjectLocation,
  type ProjectLocation,
  type ResolutionEnv,
} from '../../services/identity/project-location.js';
import { selectRuntime } from '../../services/hooks/runtime-selector.js';
import { resolveServerUrl } from '../utils/server-url.js';

export interface ServerProject {
  projectId: string;
  teamId: string;
  name: string;
  runtime: 'local' | 'team';
}

export interface ProjectCommandDeps {
  cwd: string;
  env: ResolutionEnv;
  localTeamId: () => string | null;
  ensureLocalTeamId: () => string;
  newProjectId: () => string;
  hasKeyForTeam: (teamId: string) => boolean;
  runtime: (cwd: string) => 'local' | 'server';
  /** Resolves to null when the local server is not reachable. */
  listProjects: () => Promise<ServerProject[] | null>;
  /** Registers the project at `root` with the server; false when it could not. */
  register: (root: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const MARKER_NOTE =
  'Non-secret MemSmith identity pointer. The access credential lives in ~/.memsmith, never here.';
const EXCLUDE_ENTRY = '.memsmith/';

function tilde(path: string, home: string): string {
  if (path === home) return '~';
  const rel = relative(home, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}` : path;
}

function markerReason(loc: ProjectLocation, home: string): string {
  const where = `marker in ${tilde(loc.root, home)}`;
  if (loc.root === loc.gitRoot) return `${where} (git root)`;
  if (loc.root === loc.folder) return `${where} (this folder)`;
  if (loc.boundary.kind === 'search-root') return `${where} (search root ${tilde(loc.boundary.dir, home)})`;
  if (loc.boundary.kind === 'home') return `${where} (searched up to your home folder)`;
  return where;
}

export function resolutionReason(loc: ProjectLocation, home: string): string {
  if (loc.reason === 'main-worktree' && loc.mainWorktree && loc.main) {
    const main = tilde(loc.mainWorktree, home);
    if (!loc.markerFound) return `no project yet: a session here will create one in your local team (main worktree ${main})`;
    return loc.main.root === loc.mainWorktree ? `main worktree ${main}` : `main worktree ${main}, ${markerReason(loc.main, home)}`;
  }
  if (!loc.markerFound) {
    return `no project yet: a session here will create one in your local team (${loc.gitRoot ? 'git root' : 'this folder'})`;
  }
  return markerReason(loc, home);
}

function teamLabel(marker: ProjectMarker, d: Pick<ProjectCommandDeps, 'localTeamId' | 'hasKeyForTeam'>): string {
  if (marker.runtime === 'server') {
    return d.hasKeyForTeam(marker.teamId)
      ? `joined team at ${marker.serverUrl ?? 'an unknown server'}`
      : 'a team this machine has not joined; open the dashboard and choose Join';
  }
  return marker.teamId === d.localTeamId() ? 'your local team' : 'a local team of its own';
}

function line(label: string, value: string): string {
  return `${label.padEnd(15)}${value}`;
}

export function projectSummary(cwd: string, env: ResolutionEnv = defaultResolutionEnv()): string {
  const loc = resolveProjectLocation(cwd, env);
  const marker = loc.markerFound ? readMarkerAt(loc.root) : null;
  if (!marker) return 'none yet; a session here creates one in your local team';
  return `${basename(loc.root)} (${marker.projectId}), ${resolutionReason(loc, resolve(env.home))}`;
}

export async function runProjectCommand(args: string[], d: ProjectCommandDeps = defaultProjectCommandDeps()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    d.out('Usage: memsmith project');
    return 0;
  }
  if (args.length > 0) {
    d.err(`Unknown argument: ${args[0]}`);
    d.err('Usage: memsmith project');
    return 1;
  }
  const home = resolve(d.env.home);
  const loc = resolveProjectLocation(d.cwd, d.env);
  const marker = loc.markerFound ? readMarkerAt(loc.root) : null;
  d.out(line('Folder:', loc.folder));
  d.out(line('Project root:', loc.root));
  if (marker) {
    const known = (await d.listProjects())?.find((p) => p.projectId === marker.projectId);
    d.out(line('Project:', `${known?.name ?? basename(loc.root)} (${marker.projectId})`));
    d.out(line('Team:', `${marker.teamId} (${teamLabel(marker, d)})`));
  } else {
    d.out(line('Project:', 'none'));
  }
  d.out(line('Runtime:', d.runtime(loc.folder)));
  d.out(line('Resolved by:', resolutionReason(loc, home)));
  return 0;
}

const LINK_USAGE = 'Usage: memsmith link [<project-id> | <project-name> | <path>] [--new] [--force]';

function copyMarker(source: ProjectMarker): ProjectMarker {
  return {
    teamId: source.teamId,
    projectId: source.projectId,
    note: MARKER_NOTE,
    ...(source.runtime ? { runtime: source.runtime } : {}),
    ...(source.serverUrl ? { serverUrl: source.serverUrl } : {}),
    ...(source.databaseName ? { databaseName: source.databaseName } : {}),
  };
}

function looksLikePath(target: string, folder: string): boolean {
  if (/^(\.{1,2}|~)(\/|$)/.test(target) || isAbsolute(target)) return true;
  try {
    return statSync(resolve(folder, target)).isDirectory();
  } catch {
    return false;
  }
}

function expandPath(target: string, folder: string, home: string): string {
  if (target === '~') return home;
  if (target.startsWith('~/')) return join(home, target.slice(2));
  return resolve(folder, target);
}

type TargetChoice = { marker: ProjectMarker; created: boolean } | { error: string[] };

async function pickByIdOrName(target: string, d: ProjectCommandDeps): Promise<TargetChoice> {
  const projects = await d.listProjects();
  if (!projects) {
    return { error: [
      `Looking up the project ${target} needs the MemSmith server, and it is not running.`,
      'Start it with: memsmith start',
    ] };
  }
  const byId = projects.filter((p) => p.projectId === target);
  const matches = byId.length > 0 ? byId : projects.filter((p) => p.name === target);
  if (matches.length === 0) {
    return { error: [`No project has the id or name ${target}. To see your projects, open the MemSmith dashboard.`] };
  }
  if (matches.length > 1) {
    return { error: [
      `More than one project is named ${target}:`,
      ...matches.map((p) => `  ${p.projectId}  (team ${p.teamId})`),
      'To pick one, run: memsmith link <project-id>',
    ] };
  }
  const [match] = matches;
  if (match.runtime === 'team') {
    return { error: [
      `${target} is a team project. To link to it, run memsmith link with the path of a folder that already uses it.`,
    ] };
  }
  return { marker: { teamId: match.teamId, projectId: match.projectId, note: MARKER_NOTE }, created: false };
}

async function pickTarget(
  target: string | undefined,
  fresh: boolean,
  folder: string,
  d: ProjectCommandDeps,
): Promise<TargetChoice> {
  const home = resolve(d.env.home);
  const create = (): TargetChoice => ({
    marker: { teamId: d.ensureLocalTeamId(), projectId: d.newProjectId(), note: MARKER_NOTE },
    created: true,
  });
  if (fresh) return create();
  if (target === undefined) {
    const loc = resolveProjectLocation(folder, d.env);
    const marker = loc.markerFound ? readMarkerAt(loc.root) : null;
    return marker ? { marker: copyMarker(marker), created: false } : create();
  }
  if (!looksLikePath(target, folder)) return pickByIdOrName(target, d);
  const path = expandPath(target, folder, home);
  if (!existsSync(path)) return { error: [`The folder ${path} does not exist.`] };
  const loc = resolveProjectLocation(path, d.env);
  const marker = loc.markerFound ? readMarkerAt(loc.root) : null;
  if (!marker) {
    return { error: [`The folder ${path} has no MemSmith project yet. To create one there, run memsmith link in that folder.`] };
  }
  return { marker: copyMarker(marker), created: false };
}

function excludeMarker(gitRoot: string): void {
  const path = gitInfoExcludePath(gitRoot);
  if (!path) return;
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_ENTRY || l.trim() === '/.memsmith/')) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE_ENTRY}\n`, 'utf-8');
}

export async function runLinkCommand(args: string[], d: ProjectCommandDeps = defaultProjectCommandDeps()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    d.out(LINK_USAGE);
    return 0;
  }
  const fresh = args.includes('--new');
  const force = args.includes('--force');
  const unknown = args.find((a) => a.startsWith('-') && a !== '--new' && a !== '--force');
  const positional = args.filter((a) => !a.startsWith('-'));
  if (unknown || positional.length > 1 || (fresh && positional.length > 0)) {
    d.err(unknown ? `Unknown option: ${unknown}` : 'memsmith link takes one target, and none with --new.');
    d.err(LINK_USAGE);
    return 1;
  }

  const folder = resolve(d.cwd);
  const gitRoot = findGitRoot(folder, resolve(d.env.home));
  const root = gitRoot ?? folder;
  const picked = await pickTarget(positional[0], fresh, folder, d);
  if ('error' in picked) {
    for (const l of picked.error) d.err(l);
    return 1;
  }
  const { marker, created } = picked;
  const existing = readMarkerAt(root);
  const same = existing !== null && existing.projectId === marker.projectId && existing.teamId === marker.teamId;

  if (existing && !same) {
    const change = `${root} links to project ${existing.projectId} (team ${existing.teamId}). `
      + `Linking changes it to project ${marker.projectId} (team ${marker.teamId}).`;
    if (existing.runtime === 'server' && marker.runtime !== 'server') {
      d.err(change);
      d.err('That folder belongs to a team project, and MemSmith never turns a team project local. Nothing changed.');
      return 1;
    }
    if (!force) {
      d.err(change);
      d.err('To replace the link, run the command again with --force.');
      return 1;
    }
  }

  if (!same) writeMarkerAt(root, marker);
  if (gitRoot) excludeMarker(gitRoot);

  const name = basename(root);
  if (same) d.out(`${root} already links to project ${marker.projectId}.`);
  else if (created) d.out(`Created project ${name} (${marker.projectId}) in your local team and linked ${root} to it.`);
  else d.out(`Linked ${root} to project ${marker.projectId} (team ${marker.teamId}).`);

  if (!(await d.register(root))) {
    d.err('The MemSmith server could not register the project now. It registers it on the next session in this folder.');
  }
  return 0;
}

async function fetchProjects(): Promise<ServerProject[] | null> {
  let baseUrl: string;
  try {
    baseUrl = resolveServerUrl().replace(/\/+$/, '');
  } catch {
    return null;
  }
  const store = new CredentialStore();
  const local = readLocalTeamId();
  const teams = store.listTeamIdsWithKeys().sort((a, b) => Number(b === local) - Number(a === local));
  for (const teamId of teams) {
    const key = store.resolveKeyForTeam(teamId);
    if (!key) continue;
    try {
      const res = await fetch(`${baseUrl}/v1/projects`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 401 || res.status === 403) continue;
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body) ? body as ServerProject[] : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function registerWithServer(root: string): Promise<boolean> {
  const { ensureProjectIdentityForHook, realEnsureIdentityDeps } = await import('../../cli/handlers/ensure-identity.js');
  return (await ensureProjectIdentityForHook(root, await realEnsureIdentityDeps())) !== null;
}

export function defaultProjectCommandDeps(): ProjectCommandDeps {
  const store = new CredentialStore();
  return {
    cwd: process.env.MEMSMITH_PROJECT_CWD || process.cwd(),
    env: defaultResolutionEnv(),
    localTeamId: () => readLocalTeamId(),
    ensureLocalTeamId: () => ensureLocalTeamId(),
    newProjectId: () => randomUUID(),
    hasKeyForTeam: (teamId) => Boolean(store.resolveKeyForTeam(teamId)),
    runtime: (cwd) => selectRuntime(cwd),
    listProjects: fetchProjects,
    register: registerWithServer,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}
