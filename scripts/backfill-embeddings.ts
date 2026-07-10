// SPDX-License-Identifier: Apache-2.0
//
// Backfill `observations.embedding_vec` for rows that have none (e.g. the
// bulk-migrated claude-mem rows, or any observation the generation pipeline
// left unembedded). Uses the same local ONNX embedder the vector-search arm
// uses (Xenova/all-MiniLM-L6-v2, 384-dim), so semantic search starts working
// for these rows.
//
// Idempotent: only touches rows WHERE embedding_vec IS NULL. Long-lived single
// process (model cold-start is amortised across all rows). Dry-run by default.
//
// Usage:
//   bun scripts/backfill-embeddings.ts                 # dry-run (counts only)
//   bun scripts/backfill-embeddings.ts --execute       # embed + write
//   bun scripts/backfill-embeddings.ts --execute --limit 20   # cap (testing)
//   bun scripts/backfill-embeddings.ts --execute --only-migrated  # id LIKE 'cmem-%'
//
// Env:
//   PG DSN = MEMSMITH_SERVER_DATABASE_URL
//            ?? postgres://postgres:postgres@localhost:55432/memsmith

import { Pool } from 'pg';
import { embed } from '../src/server/generation/embedder.js';

interface Args {
  execute: boolean;
  limit: number | null;
  onlyMigrated: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { execute: false, limit: null, onlyMigrated: false, batch: 32 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--only-migrated') out.onlyMigrated = true;
    else if (a === '--batch') out.batch = Number(argv[++i]);
  }
  return out;
}

// pgvector literal: bracketed comma-separated string, cast to ::public.vector
// in SQL (matches observations.ts:142 / vectorSearch).
function toVectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dsn =
    process.env.MEMSMITH_SERVER_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:55432/memsmith';

  const where = args.onlyMigrated
    ? `embedding_vec IS NULL AND id LIKE 'cmem-%'`
    : `embedding_vec IS NULL`;
  const limitClause = args.limit ? ` LIMIT ${args.limit}` : '';

  console.log(`[backfill] mode=${args.execute ? 'EXECUTE' : 'DRY-RUN'} onlyMigrated=${args.onlyMigrated} limit=${args.limit ?? 'none'} batch=${args.batch}`);
  console.log(`[backfill] target=${dsn.replace(/:[^:@/]+@/, ':****@')}`);

  const pool = new Pool({ connectionString: dsn });
  try {
    const total = await pool.query(`SELECT count(*) FROM observations WHERE ${where}`);
    const missing = Number(total.rows[0].count);
    console.log(`[backfill] rows needing embeddings: ${missing}`);
    if (missing === 0) {
      console.log('[backfill] nothing to do.');
      return;
    }

    if (!args.execute) {
      // Prove the embedder works end-to-end without writing (also warms the model
      // so the user sees the cold-start cost up front).
      const sample = await pool.query(`SELECT id, content FROM observations WHERE ${where} ORDER BY id${limitClause || ' LIMIT 1'}`);
      const first = sample.rows[0];
      console.log('[backfill] warming embedder + embedding one sample row...');
      const t0 = performance.now();
      const vec = await embed(String(first.content ?? ''));
      const ms = Math.round(performance.now() - t0);
      console.log(`[backfill] sample id=${first.id}: embedded to ${vec.length}-dim vector in ${ms}ms (incl. cold start)`);
      console.log(`[backfill] DRY-RUN — writing nothing. Re-run with --execute to embed all ${missing} rows.`);
      return;
    }

    // EXECUTE: page through the null rows, embed, write.
    const rows = (await pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM observations WHERE ${where} ORDER BY id${limitClause}`,
    )).rows;
    console.log(`[backfill] embedding + writing ${rows.length} rows...`);

    let done = 0;
    let failed = 0;
    const t0 = performance.now();
    for (let i = 0; i < rows.length; i += args.batch) {
      const slice = rows.slice(i, i + args.batch);
      // Embed the batch (embedBatch would work too; embed-per-row keeps memory flat
      // and lets one bad row fail in isolation).
      await Promise.all(
        slice.map(async r => {
          try {
            const vec = await embed(String(r.content ?? '') || ' ');
            await pool.query(
              `UPDATE observations SET embedding_vec = $1::public.vector, updated_at = updated_at WHERE id = $2`,
              [toVectorLiteral(vec), r.id],
            );
            done++;
          } catch (e) {
            failed++;
            console.warn(`[backfill] FAILED id=${r.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
      const elapsed = Math.round((performance.now() - t0) / 1000);
      console.log(`[backfill] progress ${done}/${rows.length} (failed ${failed}) — ${elapsed}s elapsed`);
    }

    const remain = await pool.query(`SELECT count(*) FROM observations WHERE ${where}`);
    console.log(`[backfill] done. embedded ${done}, failed ${failed}, still-null (matching filter) ${remain.rows[0].count}`);

    // Verify: a semantic query now returns migrated rows.
    const vq = toVectorLiteral(await embed('the claude-mem to memsmith rebrand decision'));
    const check = await pool.query(
      `SELECT id, left(content, 60) AS snip FROM observations
        WHERE embedding_vec IS NOT NULL
        ORDER BY embedding_vec OPERATOR(public.<=>) $1::public.vector LIMIT 3`,
      [vq],
    );
    console.log('[backfill] semantic sanity — nearest to "rebrand decision":');
    for (const r of check.rows) console.log(`  - ${r.id}: ${r.snip}`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch(e => {
    console.error('[backfill] FATAL:', e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
}
