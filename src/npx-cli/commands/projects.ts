// SPDX-License-Identifier: Apache-2.0
import { CredentialStore } from '../../services/identity/credential-store.js';
import { canonicalPath, defaultResolutionEnv, resolveProjectLocation, type ResolutionEnv } from '../../services/identity/project-location.js';
import { readFlatSettings } from '../../shared/flat-settings.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizeRuntimeFlag } from './server-runtime-setup.js';
import { backupsDir, pgDumpWith, type DumpDatabase } from '../../services/projects/backup.js';
import { COPY_TABLES, type CopyReport } from '../../services/projects/copy-project.js';
import { loadInventory, type ProjectEntry, type ProjectInventory } from '../../services/projects/inventory.js';
import { decideMerge, executeMerge, previewMerge, resolveProjectRef } from '../../services/projects/merge.js';
import { openLocalProjectsDb, type ProjectsDb } from '../../services/projects/projects-db.js';
import { executePrune, planPrune } from '../../services/projects/prune.js';

export interface ProjectsCommandDeps {
  cwd: string;
  env: ResolutionEnv;
  runtime: () => string;
  openDb: () => ProjectsDb;
  hasKeyForTeam: (teamId: string) => boolean;
  forgetTeamKey: (teamId: string) => void;
  dump: DumpDatabase;
  backupDir: string;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

const PROJECTS_USAGE = 'Usage: memsmith projects [--json] [--prune [--yes]]';
const MERGE_USAGE = 'Usage: memsmith merge <from> <into> [--yes]';

const TABLE_LABELS: Record<(typeof COPY_TABLES)[number], string> = {
  server_sessions: 'sessions',
  agent_events: 'events',
  observation_generation_jobs: 'completed generation jobs',
  observations: 'observations and notes',
  observation_sources: 'observation sources',
  observation_generation_job_events: 'generation job history',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function withInventory<T>(
  d: ProjectsCommandDeps,
  fn: (db: ProjectsDb, inv: ProjectInventory) => Promise<T>,
): Promise<T | number> {
  if (d.runtime() === 'server') {
    d.err('This command works with the local runtime only. Your MemSmith install uses a team server.');
    return 1;
  }
  const db = d.openDb();
  try {
    let inv: ProjectInventory;
    try {
      const loc = resolveProjectLocation(d.cwd, d.env);
      inv = await loadInventory(db.inventorySource(), {
        extraRoots: loc.markerFound ? [loc.root] : [],
        hasKeyForTeam: d.hasKeyForTeam,
      });
    } catch (error) {
      d.err(`MemSmith could not read the local database: ${error instanceof Error ? error.message : String(error)}`);
      d.err('Start MemSmith with: memsmith start');
      return 1;
    }
    return await fn(db, inv);
  } finally {
    await db.close();
  }
}

function describeRecords(p: ProjectEntry): string {
  if (!p.counts) return p.databaseName ? 'unreadable' : 'none';
  const c = p.counts;
  return `${plural(c.observations, 'observation')}, ${plural(c.notes, 'note')}, ${plural(c.events, 'event')}`;
}

function describeFlags(p: ProjectEntry): string[] {
  return p.flags.map((flag) => {
    if (flag === 'archived') return `archived (merged into ${p.mergedInto}${p.archivedAt ? ` on ${p.archivedAt.slice(0, 10)}` : ''})`;
    if (flag === 'stray') return `stray (nested under ${p.strayUnder?.map((s) => s.root).join(', ')})`;
    if (flag === 'missing-db') return 'missing-db (no database yet)';
    if (flag === 'orphan-db') return 'orphan-db (no project names this database)';
    return flag;
  });
}

function printProject(p: ProjectEntry, d: ProjectsCommandDeps): void {
  const line = (label: string, value: string) => d.out(`  ${label.padEnd(15)}${value}`);
  d.out(p.projectId ? `${p.name}  ${p.projectId}` : p.name);
  if (p.projectId) {
    line('Team:', `${p.teamId} (${p.team})`);
    line('Runtime:', p.runtime);
    line('Folders:', p.folders.length > 0 ? p.folders.join(', ') : 'none known');
  }
  line('Database:', p.databaseName ?? 'none');
  line('Records:', describeRecords(p));
  line('Last activity:', p.lastActivity ?? 'never');
  const flags = describeFlags(p);
  if (flags.length > 0) line('Flags:', flags.join('; '));
  d.out('');
}

export async function runProjectsCommand(args: string[], d: ProjectsCommandDeps = defaultProjectsCommandDeps()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    d.out(PROJECTS_USAGE);
    return 0;
  }
  const unknown = args.find((a) => !['--json', '--prune', '--yes'].includes(a));
  if (unknown || (args.includes('--yes') && !args.includes('--prune'))) {
    d.err(unknown ? `Unknown argument: ${unknown}` : '--yes goes with --prune.');
    d.err(PROJECTS_USAGE);
    return 1;
  }
  if (args.includes('--prune')) return runPrune(args.includes('--yes'), d);

  const result = await withInventory(d, async (_db, inv) => {
    if (args.includes('--json')) {
      d.out(JSON.stringify({ accountDatabase: inv.accountDatabase, projects: inv.projects, strays: inv.strays }, null, 2));
      return 0;
    }
    if (inv.projects.length === 0) {
      d.out('The local MemSmith server knows no projects yet.');
      return 0;
    }
    for (const p of inv.projects) printProject(p, d);
    return 0;
  });
  return result;
}

async function runPrune(yes: boolean, d: ProjectsCommandDeps): Promise<number> {
  return withInventory(d, async (db, inv) => {
    const plan = planPrune(inv);
    for (const k of plan.kept) d.out(`Keeping ${k.entry.name}: ${k.reason}.`);
    if (plan.candidates.length === 0) {
      d.out('Nothing to prune.');
      return 0;
    }
    const describe = (c: (typeof plan.candidates)[number]) => {
      const what = c.reason === 'orphan-db' ? 'orphan database' : c.reason === 'archived' ? `archived project, merged into ${c.entry.mergedInto}` : 'empty project';
      const steps = [c.dropDatabase ? `back up and drop database ${c.dropDatabase}` : null, c.deleteProject ? 'remove the project' : null]
        .filter(Boolean).join(', then ');
      return `${c.entry.name}${c.entry.projectId ? ` (${c.entry.projectId})` : ''}: ${what}. MemSmith will ${steps}.`;
    };
    if (!yes) {
      d.out('memsmith projects --prune would remove:');
      for (const c of plan.candidates) d.out(`  ${describe(c)}`);
      d.out(`Backups go to ${d.backupDir}.`);
      d.out('To remove them, run: memsmith projects --prune --yes');
      return 0;
    }
    const outcomes = await executePrune({ db, dump: d.dump, backupDir: d.backupDir, now: d.now, forgetTeamKey: d.forgetTeamKey }, plan);
    let failed = 0;
    for (const o of outcomes) {
      if (o.error) {
        failed += 1;
        d.err(`Could not prune ${o.candidate.entry.name}: ${o.error}. Nothing was removed for it.`);
      } else {
        d.out(`Pruned ${o.candidate.entry.name}.${o.backupFile ? ` Backup: ${o.backupFile}` : ''}`);
      }
    }
    if (outcomes.some((o) => o.droppedDatabase)) d.out('Run `memsmith restart` to release connections to dropped databases.');
    return failed > 0 ? 1 : 0;
  }) as Promise<number>;
}

function printReport(report: CopyReport, d: ProjectsCommandDeps): void {
  for (const table of COPY_TABLES) {
    const t = report.tables[table];
    if (t.source === 0) continue;
    const extra = [
      t.alreadyThere > 0 ? `${t.alreadyThere} already in the target` : null,
      t.renamed > 0 ? `${t.renamed} get a new id because the target uses theirs` : null,
    ].filter(Boolean);
    d.out(`  ${TABLE_LABELS[table]}: ${t.copy}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`);
  }
}

export async function runMergeCommand(args: string[], d: ProjectsCommandDeps = defaultProjectsCommandDeps()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    d.out(MERGE_USAGE);
    return 0;
  }
  const yes = args.includes('--yes');
  const unknown = args.find((a) => a.startsWith('-') && a !== '--yes');
  const refs = args.filter((a) => !a.startsWith('-'));
  if (unknown || refs.length !== 2) {
    d.err(unknown ? `Unknown option: ${unknown}` : 'memsmith merge takes two projects: the one to fold in, then the one to keep.');
    d.err(MERGE_USAGE);
    return 1;
  }

  return withInventory(d, async (db, inv) => {
    const ctx = { cwd: d.cwd, env: d.env };
    const from = resolveProjectRef(inv, refs[0], ctx);
    const into = resolveProjectRef(inv, refs[1], ctx);
    for (const r of [from, into]) if (typeof r === 'string') d.err(r);
    if (typeof from === 'string' || typeof into === 'string') return 1;

    const decision = decideMerge(from, into);
    if (decision.refusal) {
      d.err(`${decision.refusal} Nothing changed.`);
      return 1;
    }
    const label = (p: ProjectEntry) => `${p.name} (${p.projectId})`;

    if (!yes) {
      const report = await previewMerge(db, decision);
      d.out(`memsmith merge would fold ${label(from)} into ${label(into)}.`);
      d.out('Rows to copy:');
      printReport(report, d);
      if (report.jobsLeftBehind.active > 0) {
        d.out(`  ${plural(report.jobsLeftBehind.active, 'queued or running generation job')} in ${from.name} will be cancelled, not moved. Their events move.`);
      }
      if (report.jobsLeftBehind.finished > 0) {
        d.out(`  ${plural(report.jobsLeftBehind.finished, 'failed or cancelled generation job')} stay with ${from.name}.`);
      }
      d.out(decision.repoint.length > 0 ? 'Markers that will link to the target:' : 'No known folder links to the source project.');
      for (const dir of decision.repoint) d.out(`  ${dir}`);
      d.out(`MemSmith backs up ${from.databaseName} to ${d.backupDir} first, and keeps it after the merge.`);
      d.out(`To merge, run: memsmith merge ${shellQuote(from.projectId!)} ${shellQuote(into.projectId!)} --yes`);
      return 0;
    }

    try {
      const result = await executeMerge({ db, dump: d.dump, backupDir: d.backupDir, now: d.now }, decision);
      d.out(`Backed up ${from.databaseName} to ${result.backupFile}.`);
      if (result.cancelledJobs > 0) d.out(`Cancelled ${plural(result.cancelledJobs, 'queued or running generation job')} in ${from.name}.`);
      d.out(`Merged ${label(from)} into ${label(into)}:`);
      printReport(result.report, d);
      if (result.lateRows > 0) d.out(`  Also copied ${plural(result.lateRows, 'row')} that arrived during the merge.`);
      for (const dir of result.repointed) d.out(`Linked ${dir} to ${into.name}.`);
      for (const s of result.skippedMarkers) d.err(`Left ${s.dir} unchanged: ${s.reason}.`);
      d.out(`${from.name} is archived. Its database stays; to remove it, run: memsmith projects --prune`);
      return 0;
    } catch (error) {
      d.err(`The merge stopped: ${error instanceof Error ? error.message : String(error)}`);
      d.err('The copy runs in one transaction, so a failed copy adds no rows to the target. You can run the merge again.');
      return 1;
    }
  }) as Promise<number>;
}

function readRuntimeSetting(): string {
  let raw = process.env.MEMSMITH_RUNTIME;
  if (!raw) {
    try {
      const value = readFlatSettings(USER_SETTINGS_PATH)?.MEMSMITH_RUNTIME;
      raw = typeof value === 'string' ? value : undefined;
    } catch {
      raw = undefined;
    }
  }
  return normalizeRuntimeFlag(raw) ?? 'local';
}

export function defaultProjectsCommandDeps(): ProjectsCommandDeps {
  const store = new CredentialStore();
  return {
    cwd: canonicalPath(process.env.MEMSMITH_PROJECT_CWD || process.cwd()),
    env: defaultResolutionEnv(),
    runtime: readRuntimeSetting,
    openDb: () => openLocalProjectsDb(),
    hasKeyForTeam: (teamId) => Boolean(store.resolveKeyForTeam(teamId)),
    forgetTeamKey: (teamId) => store.removeKeyForTeam(teamId),
    dump: pgDumpWith(),
    backupDir: backupsDir(),
    now: () => new Date(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}
