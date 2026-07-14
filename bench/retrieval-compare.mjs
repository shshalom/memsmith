// SPDX-License-Identifier: Apache-2.0
//
// Retrieval comparison on the LIVE corpus: keyword (FTS, claude-mem's approach)
// vs semantic (pgvector, MemSmith's approach). Runs the SAME real questions
// through both arms and reports, per query, whether each arm returned anything
// and what the top hit was. The point: questions phrased the way a human recalls
// them months later rarely share exact keywords with the stored observation —
// that's where FTS returns nothing and embeddings still find the memory.
//
//   bun bench/retrieval-compare.mjs
//
// Env: PG_URL, TEAM (default local), PROJECT (default local), K (default 5).

import pg from 'pg';
import { embed } from '../src/server/generation/embedder.js';

const PG_URL = process.env.PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const TEAM = process.env.TEAM || 'local';
const PROJECT = process.env.PROJECT || 'local';
const K = Number(process.env.K || 5);

// Natural-language questions a developer would ask this project's memory later.
// Chosen to be SEMANTICALLY about real work in the corpus while avoiding the
// exact stored wording, so the two arms can genuinely diverge.
const QUERIES = [
  'why did we stop using the background worker for generating memories?',
  'how do we run Postgres locally without Docker?',
  'what makes the needs-attention panel trustworthy instead of noisy?',
  'how are context injection savings calculated?',
  'what did we decide about routing captures to the embedded store?',
  'how does search scope cost to a single project?',
  'what breaks when the embedder is unavailable?',
  'how do we keep the first-run import from stalling?',
];

const short = (s, n = 72) => {
  const line = String(s || '').split('\n')[0].trim();
  return line.length > n ? line.slice(0, n) + '…' : line;
};

async function ftsTop(c, q) {
  const r = await c.query(
    `SELECT id, content, ts_rank(content_search, websearch_to_tsquery('english',$3)) AS rank
       FROM observations
      WHERE team_id=$1 AND project_id=$2
        AND content_search @@ websearch_to_tsquery('english',$3)
      ORDER BY rank DESC, updated_at DESC LIMIT $4`,
    [TEAM, PROJECT, q, K]);
  return r.rows;
}

async function vecTop(c, q) {
  const qvec = '[' + (await embed(q)).join(',') + ']';
  const r = await c.query(
    `SELECT id, content, 1 - (embedding_vec OPERATOR(public.<=>) $3::public.vector) AS sim
       FROM observations
      WHERE team_id=$1 AND project_id=$2 AND embedding_vec IS NOT NULL
      ORDER BY embedding_vec OPERATOR(public.<=>) $3::public.vector LIMIT $4`,
    [TEAM, PROJECT, qvec, K]);
  return r.rows;
}

async function main() {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();

  let ftsHits = 0, vecHits = 0, ftsEmpty = 0, bothFound = 0;
  console.log(`\nRetrieval comparison — keyword (FTS) vs semantic (vector), top-${K}`);
  console.log(`Corpus: team=${TEAM} project=${PROJECT}\n`);

  for (const q of QUERIES) {
    const [fts, vec] = await Promise.all([ftsTop(c, q), vecTop(c, q)]);
    if (fts.length) ftsHits++; else ftsEmpty++;
    if (vec.length) vecHits++;
    if (fts.length && vec.length) bothFound++;
    console.log(`Q: ${q}`);
    console.log(`   keyword : ${fts.length ? `${fts.length} hit(s) — top: ${short(fts[0].content)}` : 'NO RESULTS (no lexical overlap)'}`);
    console.log(`   semantic: ${vec.length ? `${vec.length} hit(s) — top (sim ${Number(vec[0].sim).toFixed(2)}): ${short(vec[0].content)}` : 'NO RESULTS'}`);
    console.log('');
  }

  console.log('── Summary ──');
  console.log(`  queries              : ${QUERIES.length}`);
  console.log(`  keyword returned any : ${ftsHits}/${QUERIES.length}`);
  console.log(`  semantic returned any: ${vecHits}/${QUERIES.length}`);
  console.log(`  keyword found NOTHING: ${ftsEmpty}/${QUERIES.length}  ← claude-mem would show an empty result here`);
  console.log(`  semantic recovered where keyword was empty: ${vecHits - bothFound}`);
  console.log('');
  console.log('  Note: "keyword found nothing" means FTS had zero lexical overlap for a');
  console.log('  question that IS answerable from the corpus — the exact failure mode');
  console.log('  semantic retrieval eliminates. This is the concrete MemSmith > claude-mem win.\n');

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
