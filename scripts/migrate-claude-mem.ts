// SPDX-License-Identifier: Apache-2.0
//
// One-off ETL: copy a project's observations from the upstream claude-mem
// SQLite store into MemSmith's Postgres store, transforming the flat worker
// shape into MemSmith's typed server shape.
//
// Dry-run by default. Idempotent (stable `cmem-<id>` primary keys +
// ON CONFLICT DO NOTHING). Source DB is opened READ-ONLY and never mutated.
//
// The target is the local database of the MemSmith project at --cwd, read from
// its .memsmith/project.json. The source project name defaults to that
// project's folder name.
//
// Usage:
//   bun scripts/migrate-claude-mem.ts --cwd ~/Workspace/App              # dry-run
//   bun scripts/migrate-claude-mem.ts --cwd ~/Workspace/App --execute    # load
//   bun scripts/migrate-claude-mem.ts --cwd ... --limit 5                # cap rows
//   bun scripts/migrate-claude-mem.ts --cwd ... --project X              # source name
//
// Env: SOURCE_DB (default ~/.claude-mem/claude-mem.db), MEMSMITH_LOCAL_PG_PORT.

import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { requireDirectory, resolveLocalTarget } from './lib/local-target.js';

interface Args {
  execute: boolean;
  limit: number | null;
  project: string | null;
  cwd: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { execute: false, limit: null, project: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--project') out.project = String(argv[++i]);
    else if (a === '--cwd') out.cwd = requireDirectory(argv[++i]);
  }
  return out;
}

// --- transform (pure; exported for the unit test) ---------------------------

export interface SourceRow {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  memory_session_id: string | null;
  agent_type: string | null;
  agent_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface TargetRow {
  id: string;
  team_id: string;
  project_id: string;
  kind: string;
  obs_type: string;
  lifecycle_state: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Parse a JSON field defensively: return the parsed value, or (on failure)
// wrap the raw string so nothing is lost and nothing throws.
function parseJsonSoft(raw: string | null, fallbackKey: 'array' | 'object'): unknown {
  if (raw == null || raw === '') return fallbackKey === 'array' ? [] : {};
  try {
    return JSON.parse(raw);
  } catch {
    return fallbackKey === 'array' ? [raw] : { raw };
  }
}

export function transform(row: SourceRow, teamId: string, projectId: string): TargetRow {
  const facts = parseJsonSoft(row.facts, 'array');
  const concepts = parseJsonSoft(row.concepts, 'array');
  const filesRead = parseJsonSoft(row.files_read, 'array');
  const filesModified = parseJsonSoft(row.files_modified, 'array');
  const srcMeta = parseJsonSoft(row.metadata, 'object') as Record<string, unknown>;

  // content: richest available body.
  const titleLine = [row.title, row.subtitle].filter(Boolean).join(' — ');
  const content =
    (row.text && row.text.trim()) ||
    (row.narrative && row.narrative.trim()) ||
    titleLine ||
    (row.title ?? '') ||
    '(no content)';

  // obs_type: keep the source type verbatim (MemSmith's obs_type is free text
  // and already understands these). lifecycle: resolved, except decisions stay active.
  const obsType = row.type;
  const lifecycleState = row.type === 'decision' ? 'active' : 'resolved';

  const metadata: Record<string, unknown> = {
    ...srcMeta,
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    facts,
    narrative: row.narrative ?? undefined,
    concepts,
    files_read: filesRead,
    files_modified: filesModified,
    prompt_number: row.prompt_number ?? undefined,
    discovery_tokens: row.discovery_tokens ?? undefined,
    memory_session_id: row.memory_session_id ?? undefined,
    agent_type: row.agent_type ?? undefined,
    agent_id: row.agent_id ?? undefined,
    source: 'claude-mem-migration',
    source_id: row.id,
  };

  return {
    id: `cmem-${row.id}`,
    team_id: teamId,
    project_id: projectId,
    kind: 'observation',
    obs_type: obsType,
    lifecycle_state: lifecycleState,
    content,
    metadata,
    created_at: row.created_at,
    updated_at: row.created_at,
  };
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cwd) throw new Error('--cwd <project directory> is required');
  const sourcePath = process.env.SOURCE_DB ?? join(homedir(), '.claude-mem', 'claude-mem.db');
  const { root, dsn, teamId, projectId, databaseName } = resolveLocalTarget(args.cwd);
  const sourceProject = args.project ?? basename(root);

  console.log(`[migrate] mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'} source project="${sourceProject}" limit=${args.limit ?? 'none'}`);
  console.log(`[migrate] source=${sourcePath}`);
  console.log(`[migrate] target=${databaseName} (${root}) team=${teamId} project=${projectId}`);

  const sqlite = new Database(sourcePath, { readonly: true });
  const limitClause = args.limit ? ` LIMIT ${args.limit}` : '';
  const rows = sqlite
    .query(
      `SELECT id, type, title, subtitle, text, facts, narrative, concepts,
              files_read, files_modified, prompt_number, discovery_tokens,
              memory_session_id, agent_type, agent_id, metadata, created_at
         FROM observations WHERE project = ?${limitClause}`,
    )
    .all(sourceProject) as SourceRow[];
  console.log(`[migrate] extracted ${rows.length} source rows`);

  let transformed = 0;
  let skipped = 0;
  const targets: TargetRow[] = [];
  for (const r of rows) {
    try {
      targets.push(transform(r, teamId, projectId));
      transformed++;
    } catch (e) {
      skipped++;
      console.warn(`[migrate] skip source id=${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`[migrate] transformed ${transformed}, skipped ${skipped}`);

  // obs_type distribution
  const dist = new Map<string, number>();
  for (const t of targets) dist.set(t.obs_type, (dist.get(t.obs_type) ?? 0) + 1);
  console.log('[migrate] obs_type distribution:', Object.fromEntries([...dist.entries()].sort((a, b) => b[1] - a[1])));

  const pool = new Pool({ connectionString: dsn });
  try {
    // Fail loud before any insert rather than FK-violate mid-batch.
    const chk = await pool.query('SELECT (SELECT count(*) FROM teams WHERE id=$1) AS t, (SELECT count(*) FROM projects WHERE id=$2) AS p', [teamId, projectId]);
    if (Number(chk.rows[0].t) === 0 || Number(chk.rows[0].p) === 0) {
      throw new Error(`team (${chk.rows[0].t}) or project (${chk.rows[0].p}) row missing in ${databaseName}`);
    }
    const present = await pool.query(
      'SELECT count(*) AS n, count(*) FILTER (WHERE project_id <> $2) AS foreign FROM observations WHERE id = ANY($1::text[])',
      [targets.map(t => t.id), projectId],
    );
    // ON CONFLICT DO NOTHING would silently leave these under the other project.
    if (Number(present.rows[0].foreign) > 0) {
      throw new Error(`${present.rows[0].foreign} source rows are already in ${databaseName} under a different project`);
    }
    const total = await pool.query('SELECT count(*) FROM observations');
    console.log(`[migrate] target has ${total.rows[0].count} observations; ${present.rows[0].n} of the ${targets.length} source rows are already loaded`);

    if (!args.execute) {
      console.log('[migrate] DRY-RUN — inserting nothing. Sample transformed rows:');
      for (const t of targets.slice(0, 3)) {
        console.log(JSON.stringify({ id: t.id, obs_type: t.obs_type, lifecycle_state: t.lifecycle_state, content: t.content.slice(0, 80), factsCount: Array.isArray((t.metadata as any).facts) ? (t.metadata as any).facts.length : 0 }, null, 2));
      }
      console.log('[migrate] done (dry-run). Re-run with --execute to load.');
      return;
    }

    let inserted = 0;
    const batchSize = 200;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      // Build a multi-row INSERT ... ON CONFLICT (id) DO NOTHING.
      const cols = ['id', 'team_id', 'project_id', 'kind', 'obs_type', 'lifecycle_state', 'content', 'metadata', 'created_at', 'updated_at'];
      const values: unknown[] = [];
      const tuples: string[] = [];
      batch.forEach((t, j) => {
        const base = j * cols.length;
        tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8}::jsonb,$${base + 9},$${base + 10})`);
        values.push(t.id, t.team_id, t.project_id, t.kind, t.obs_type, t.lifecycle_state, t.content, JSON.stringify(t.metadata), t.created_at, t.updated_at);
      });
      const res = await pool.query(
        `INSERT INTO observations (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (id) DO NOTHING`,
        values,
      );
      inserted += res.rowCount ?? 0;
      console.log(`[migrate] batch ${i / batchSize + 1}: +${res.rowCount ?? 0} (running ${inserted})`);
    }

    const after = await pool.query('SELECT count(*) FROM observations');
    console.log(`[migrate] target observations after: ${after.rows[0].count} (inserted ${inserted})`);

    const vdist = await pool.query(`SELECT obs_type, count(*) FROM observations WHERE id LIKE 'cmem-%' AND project_id = $1 GROUP BY obs_type ORDER BY 2 DESC`, [projectId]);
    console.log('[migrate] loaded obs_type distribution:', vdist.rows);
  } finally {
    await pool.end();
    sqlite.close();
  }
  console.log('[migrate] done (execute).');
}

if (import.meta.main) {
  main().catch(e => {
    console.error('[migrate] FATAL:', e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
