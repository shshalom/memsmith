// SPDX-License-Identifier: Apache-2.0
// Diagnostic: for given question_ids, ingest the haystack, run FTS-only,
// vector-only, and fused hybrid search, and show WHERE the gold session ranks
// in each — to locate why a question fails (not in pool? ranked >5? which arm?).
//
//   export MEMSMITH_TEST_POSTGRES_URL=... LME_DATASET_PATH=...
//   bun run bench/longmemeval/diagnose.ts <question_id> [question_id...]

import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../src/storage/postgres/observations.js';
import { embed } from '../../src/server/generation/embedder.js';

const dbUrl = process.env.MEMSMITH_TEST_POSTGRES_URL!;
const datasetPath = process.env.LME_DATASET_PATH!;
const wanted = new Set(process.argv.slice(2));

interface LmeItem {
  question_id: string; question_type: string; question: string;
  answer_session_ids: string[]; haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

const flatten = (t: Array<{ role: string; content: string }>) => t.map(x => `${x.role}: ${x.content}`).join('\n');
const rankOf = (ids: string[], gold: Set<string>) => { const i = ids.findIndex(x => gold.has(x)); return i === -1 ? '—' : String(i); };

async function main() {
  const fs = await import('fs/promises');
  const dataset: LmeItem[] = JSON.parse(await fs.readFile(datasetPath, 'utf-8'));
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  const schema = `dx_${randomUUID().replaceAll('-', '_')}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  await bootstrapServerPostgresSchema(client);
  const storage = createPostgresStorageRepositories(client);
  const team = await storage.teams.create({ name: 'dx' });
  const teamId = team.id;
  const repo = new PostgresObservationRepository(client);

  for (const item of dataset) {
    if (!wanted.has(item.question_id)) continue;
    const project = await storage.projects.create({ teamId, name: `dx-${item.question_id}` });
    const projectId = project.id;
    const nsId = (s: string) => `${item.question_id}::${s}`;
    const gold = new Set(item.answer_session_ids.map(nsId));

    const seen = new Set<string>();
    for (let i = 0; i < item.haystack_session_ids.length; i++) {
      const sid = item.haystack_session_ids[i]!;
      if (seen.has(sid)) continue; seen.add(sid);
      const content = flatten(item.haystack_sessions[i] ?? []);
      if (!content.trim()) continue;
      await repo.create({ id: nsId(sid), projectId, teamId, content, embeddingVec: await embed(content) });
    }

    const fts = (await repo.search({ projectId, teamId, query: item.question, limit: 30 })).map(o => o.id);
    const vec = (await repo.vectorSearch({ projectId, teamId, query: item.question, limit: 30 })).map(o => o.id);
    const hyb = (await repo.hybridSearch({ projectId, teamId, query: item.question, limit: 10 })).map(o => o.id);

    console.log(`\n=== ${item.question_id} [${item.question_type}] ===`);
    console.log(`Q: ${item.question}`);
    console.log(`gold sessions: ${item.answer_session_ids.join(', ')}  (of ${seen.size} sessions)`);
    console.log(`gold rank — FTS: ${rankOf(fts, gold)} | VECTOR: ${rankOf(vec, gold)} | HYBRID(top10): ${rankOf(hyb, gold)}`);
    // Show gold content head so we can see if it's even textually matchable
    const goldIdx = item.haystack_session_ids.findIndex(s => item.answer_session_ids.includes(s));
    if (goldIdx >= 0) console.log(`gold head: ${flatten(item.haystack_sessions[goldIdx] ?? []).slice(0, 200).replace(/\n/g, ' ')}`);
  }

  await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
  client.release();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
