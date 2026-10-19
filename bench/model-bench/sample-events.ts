// SPDX-License-Identifier: Apache-2.0
//
// Draws a stratified sample of REAL captured agent events from the local runtime's
// Postgres so the model bench measures the traffic MemSmith actually sees, not only
// the 10 synthetic events in bench/quality-eval/corpus.ts.
//
// The output holds the user's own session data, so it is written to a gitignored
// file and never committed.
//
// Usage:
//   bun bench/model-bench/sample-events.ts [database] [seed]
// database defaults to the largest msp_* project database.

import { writeFileSync } from 'fs';
import pg from 'pg';

const BASE = process.env.MEMSMITH_BENCH_PG ?? 'postgres://memsmith:memsmith-local@127.0.0.1:55433';

// Quotas follow the observed tool mix (Bash dominates), with every high-signal
// event type represented at least once.
const QUOTAS: Array<{ label: string; where: string; n: number }> = [
  { label: 'bash', where: `event_type='tool_use' and payload->>'tool_name'='Bash'`, n: 14 },
  { label: 'assistant', where: `event_type='assistant_message'`, n: 7 },
  { label: 'read', where: `event_type='tool_use' and payload->>'tool_name'='Read'`, n: 4 },
  { label: 'edit', where: `event_type='tool_use' and payload->>'tool_name'='Edit'`, n: 3 },
  { label: 'write', where: `event_type='tool_use' and payload->>'tool_name'='Write'`, n: 2 },
  { label: 'agent', where: `event_type='tool_use' and payload->>'tool_name'='Agent'`, n: 3 },
  { label: 'speak', where: `event_type='tool_use' and payload->>'tool_name' like 'mcp__voicesmith__speak%'`, n: 2 },
  { label: 'mobile', where: `event_type='tool_use' and payload->>'tool_name' like 'mcp__mobile-mcp__%'`, n: 2 },
  { label: 'memsearch', where: `event_type='tool_use' and payload->>'tool_name' like 'mcp__plugin_memsmith_mem__%'`, n: 1 },
  { label: 'ask', where: `event_type='tool_use' and payload->>'tool_name'='AskUserQuestion'`, n: 1 },
  { label: 'monitor', where: `event_type='tool_use' and payload->>'tool_name' in ('Monitor','TaskStop','ToolSearch','Skill')`, n: 1 },
];

async function pickDatabase(): Promise<string> {
  const c = new pg.Client({ connectionString: `${BASE}/postgres` });
  await c.connect();
  const r = await c.query(
    `select datname from pg_database where datname like 'msp_%' order by pg_database_size(datname) desc limit 1`,
  );
  await c.end();
  return r.rows[0].datname as string;
}

async function main(): Promise<void> {
  const db = process.argv[2] ?? (await pickDatabase());
  const seed = Number(process.argv[3] ?? 0.42);
  const c = new pg.Client({ connectionString: `${BASE}/${db}` });
  await c.connect();
  await c.query('select setseed($1)', [seed]);

  const events: Array<{ label: string; eventType: string; payload: unknown }> = [];
  for (const q of QUOTAS) {
    const r = await c.query(
      `select event_type, payload from agent_events where ${q.where} order by random() limit ${q.n}`,
    );
    r.rows.forEach((row, i) => events.push({ label: `${q.label}-${i + 1}`, eventType: row.event_type, payload: row.payload }));
  }
  await c.end();

  const out = new URL('./.corpus.local.json', import.meta.url).pathname;
  writeFileSync(out, JSON.stringify(events, null, 2));
  console.log(`Sampled ${events.length} real events from ${db} -> ${out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
