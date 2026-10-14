// SPDX-License-Identifier: Apache-2.0
//
// Recover observations for a stretch of sessions no memory tool captured, by
// replaying the tool calls in Claude Code's saved transcripts through the same
// /v1/events path the PostToolUse hook uses. The server generates observations
// from them as it would from live capture.
//
// Dry-run by default. Each event keeps its original timestamp and payload, which
// the server's event key is built from, so a re-run is deduplicated by the
// server. Generation shares the local model with live capture, so events
// are fed in small batches and the script waits for the project's queue to
// drain before sending more, so a live job from another project waits behind at
// most one batch.
//
// Usage:
//   bun scripts/replay-transcript-gap.ts --cwd ~/Workspace/App --from <iso> --to <iso>            # dry-run
//   bun scripts/replay-transcript-gap.ts --cwd ... --from ... --to ... --execute [--limit N] [--batch N] [--stall-minutes N]
//   bun scripts/replay-transcript-gap.ts --cwd ... --from ... --to ... --backdate
//
// --backdate runs after generation finishes: it sets each generated
// observation's created_at to the time of the tool call it came from. It only
// touches observations generated more than an hour after their tool call, which
// live capture never produces.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { requireDirectory, resolveLocalTarget } from './lib/local-target.js';
import { resolveRuntimeContext } from '../src/services/hooks/runtime-selector.js';
import type { ServerRecordEventRequest } from '../src/services/hooks/server-client.js';
import { scrubEventPayload } from '../src/server/services/event-payload-scrub.js';

export interface ReplayCall {
  toolUseId: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  agentId?: string;
  occurredAtEpoch: number;
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  agentId?: string;
  timestamp?: string;
  toolUseResult?: unknown;
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/**
 * Pair each tool_use with its tool_result. The call counts as happening when
 * the result arrives, which is when the PostToolUse hook would have fired.
 * Calls with no result (interrupted sessions) and failed calls are dropped:
 * PostToolUse never fires for either, so live capture would not have seen them.
 */
export function extractToolCalls(jsonl: string, fromEpoch: number, toEpoch: number): ReplayCall[] {
  const pending = new Map<string, { line: TranscriptLine; block: ContentBlock }>();
  const calls: ReplayCall[] = [];
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    for (const block of blocks(line)) {
      if (block.type === 'tool_use' && block.id && block.name) {
        pending.set(block.id, { line, block });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const use = pending.get(block.tool_use_id);
        if (!use) continue;
        pending.delete(block.tool_use_id);
        if (block.is_error) continue;
        const at = Date.parse(line.timestamp ?? '');
        if (!Number.isFinite(at) || at < fromEpoch || at > toEpoch) continue;
        const sessionId = use.line.sessionId ?? line.sessionId;
        const cwd = use.line.cwd ?? line.cwd;
        if (!sessionId || !cwd) continue;
        calls.push({
          toolUseId: block.tool_use_id,
          sessionId,
          cwd,
          toolName: use.block.name!,
          toolInput: use.block.input ?? {},
          toolResponse: line.toolUseResult ?? block.content ?? '',
          agentId: use.line.agentId,
          occurredAtEpoch: at,
        });
      }
    }
  }
  return calls;
}

/**
 * The event the PostToolUse hook would have sent. The server's dedup key is
 * built from this payload, so any change to its shape makes a re-run store
 * every event a second time.
 */
export function buildEvent(call: ReplayCall, projectId: string): ServerRecordEventRequest {
  return {
    projectId,
    contentSessionId: call.sessionId,
    platformSource: 'claude',
    sourceType: 'hook',
    eventType: 'tool_use',
    occurredAtEpoch: call.occurredAtEpoch,
    payload: {
      tool_name: call.toolName,
      tool_input: scrubEventPayload(call.toolInput),
      tool_response: scrubEventPayload(call.toolResponse),
      cwd: call.cwd,
      agentId: call.agentId,
      platformSource: 'claude',
    },
  };
}

function transcriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...transcriptFiles(path));
    else if (name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** Claude Code names a project's transcript folder after its path, with every non-alphanumeric character as a dash. */
export function transcriptDirFor(root: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
}

export interface Args {
  cwd: string | null;
  from: number | null;
  to: number | null;
  execute: boolean;
  backdate: boolean;
  limit: number | null;
  batch: number;
  stallMinutes: number;
}

// A time with no zone would be read as local time and shift the window.
function parseTime(value: string | undefined, flag: string): number {
  const at = Date.parse(value ?? '');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(value ?? '') || !Number.isFinite(at)) {
    throw new Error(`${flag} needs an ISO timestamp with a time zone, such as 2026-10-10T22:48:00Z`);
  }
  return at;
}

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive whole number`);
  return n;
}

// Any mistyped flag is an error, so a typo never turns a test run into the full replay.
export function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: null, from: null, to: null, execute: false, backdate: false, limit: null, batch: 4, stallMinutes: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') out.cwd = requireDirectory(argv[++i]);
    else if (a === '--from') out.from = parseTime(argv[++i], '--from');
    else if (a === '--to') out.to = parseTime(argv[++i], '--to');
    else if (a === '--execute') out.execute = true;
    else if (a === '--backdate') out.backdate = true;
    else if (a === '--limit') out.limit = positiveInt(argv[++i], '--limit');
    else if (a === '--batch') out.batch = positiveInt(argv[++i], '--batch');
    else if (a === '--stall-minutes') out.stallMinutes = positiveInt(argv[++i], '--stall-minutes');
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.cwd || out.from === null || out.to === null) throw new Error('--cwd, --from, and --to are required');
  if (out.from >= out.to) throw new Error('--from must be earlier than --to');
  return out;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait until fewer than `below` of the project's jobs can still run. A job the
 * server can never pick up again does not count: one stuck in processing past
 * the stale-lock age, or one put back in the queue with no attempts left. Exits
 * if none of this project's jobs finishes for `stallMs` rather than waiting
 * forever. The model is shared with live capture in every project, so the
 * window must cover a backlog elsewhere draining first.
 */
async function waitForQueue(pool: Pool, projectId: string, below: number, stallMs: number): Promise<void> {
  let lastDone = -1;
  let lastProgressAt = Date.now();
  for (;;) {
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE (status = 'queued' AND attempts < max_attempts)
                                  OR (status = 'processing' AND locked_at > now() - interval '30 minutes'))::int AS active,
              count(*) FILTER (WHERE status IN ('completed','failed','cancelled'))::int AS done
         FROM observation_generation_jobs WHERE project_id = $1`,
      [projectId],
    );
    const { active, done } = r.rows[0] as { active: number; done: number };
    if (active < below) return;
    if (done !== lastDone) {
      lastDone = done;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallMs) {
      throw new Error(`no generation job finished for ${stallMs / 60_000} minutes with ${active} still active; check the MemSmith server, then re-run (sent events are deduplicated)`);
    }
    await sleep(15_000);
  }
}

async function reportJobs(pool: Pool, projectId: string, from: number, to: number): Promise<void> {
  const r = await pool.query(
    `SELECT j.status, count(*)::int AS n
       FROM observation_generation_jobs j
       JOIN agent_events e ON e.id = j.agent_event_id
      WHERE j.project_id = $1 AND e.occurred_at BETWEEN $2 AND $3
      GROUP BY j.status ORDER BY j.status`,
    [projectId, new Date(from), new Date(to)],
  );
  console.log('[replay] generation jobs for this window:', Object.fromEntries(r.rows.map((x: { status: string; n: number }) => [x.status, x.n])));
}

async function backdate(pool: Pool, projectId: string, from: number, to: number): Promise<void> {
  const r = await pool.query(
    `UPDATE observations o
        SET created_at = e.occurred_at, updated_at = e.occurred_at
       FROM observation_sources s
       JOIN agent_events e ON e.id = s.agent_event_id
      WHERE s.observation_id = o.id
        AND s.source_type = 'agent_event'
        AND o.project_id = $1
        AND e.occurred_at BETWEEN $2 AND $3
        AND o.created_at > e.occurred_at + interval '1 hour'`,
    [projectId, new Date(from), new Date(to)],
  );
  console.log(`[replay] backdated ${r.rowCount ?? 0} observations to their tool call times`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveLocalTarget(args.cwd!);
  const pool = new Pool({ connectionString: target.dsn });
  try {
    if (args.backdate) {
      await backdate(pool, target.projectId, args.from!, args.to!);
      return;
    }

    const dir = transcriptDirFor(target.root);
    if (!existsSync(dir)) throw new Error(`no Claude Code transcripts at ${dir}`);
    const seen = new Set<string>();
    let calls: ReplayCall[] = [];
    for (const file of transcriptFiles(dir)) {
      for (const call of extractToolCalls(readFileSync(file, 'utf-8'), args.from!, args.to!)) {
        // A resumed session repeats earlier turns in its new transcript.
        if (seen.has(call.toolUseId)) continue;
        seen.add(call.toolUseId);
        calls.push(call);
      }
    }
    calls.sort((a, b) => a.occurredAtEpoch - b.occurredAtEpoch);
    if (args.limit !== null) calls = calls.slice(0, args.limit);

    const sessions = new Set(calls.map(c => c.sessionId));
    const tools = new Map<string, number>();
    for (const c of calls) tools.set(c.toolName, (tools.get(c.toolName) ?? 0) + 1);
    console.log(`[replay] mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'} target=${target.databaseName} (${target.root})`);
    console.log(`[replay] window ${new Date(args.from!).toISOString()} .. ${new Date(args.to!).toISOString()}`);
    console.log(`[replay] ${calls.length} tool calls across ${sessions.size} sessions from ${dir}`);
    console.log('[replay] by tool:', Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)));
    if (!args.execute) {
      console.log('[replay] DRY-RUN — sending nothing. Re-run with --execute.');
      return;
    }

    const runtime = resolveRuntimeContext(target.root);
    if (runtime.runtime !== 'server' || runtime.projectId !== target.projectId) {
      throw new Error(`MemSmith is not reachable for ${target.root} (${runtime.runtime === 'server' ? 'project mismatch' : runtime.reason})`);
    }

    let sent = 0;
    for (let i = 0; i < calls.length; i += args.batch) {
      await waitForQueue(pool, target.projectId, args.batch, args.stallMinutes * 60_000);
      for (const c of calls.slice(i, i + args.batch)) {
        await runtime.client.recordEvent(buildEvent(c, target.projectId));
        sent++;
      }
      console.log(`[replay] sent ${sent}/${calls.length}`);
    }
    await waitForQueue(pool, target.projectId, 1, args.stallMinutes * 60_000);
    await reportJobs(pool, target.projectId, args.from!, args.to!);
    console.log(`[replay] done. Sent ${sent} events. Run --backdate next.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch(e => {
    console.error('[replay] FATAL:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
