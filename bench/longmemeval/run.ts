// SPDX-License-Identifier: Apache-2.0
// LongMemEval-S benchmark harness for the Team Agent Memory hybrid retrieval path.
// Scoring functions are pure and unit-tested; main() runs the real dataset (see README).

export function scoreRecallAtK(retrievedIds: string[], goldIds: string[], k: number): number {
  const topK = new Set(retrievedIds.slice(0, k));
  return goldIds.some(g => topK.has(g)) ? 1 : 0;
}

export function mrr(retrievedIds: string[], goldIds: string[]): number {
  const gold = new Set(goldIds);
  const idx = retrievedIds.findIndex(id => gold.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

// ---------------------------------------------------------------------------
// main() — runs the real LongMemEval-S dataset evaluation.
// Guarded behind import.meta.main so importing scoring functions in tests does
// NOT trigger a dataset run.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const datasetPath = process.env.LME_DATASET_PATH;
  if (!datasetPath) {
    console.error(
      'Error: LME_DATASET_PATH is not set.\n' +
        'Download LongMemEval-S and set LME_DATASET_PATH to the JSON file path.\n' +
        'See bench/longmemeval/README.md for full instructions.',
    );
    process.exit(1);
  }

  const dbUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
  if (!dbUrl) {
    console.error(
      'Error: CLAUDE_MEM_TEST_POSTGRES_URL is not set.\n' +
        'Provide a Postgres 16 + pgvector connection string.\n' +
        'See bench/longmemeval/README.md for full instructions.',
    );
    process.exit(1);
  }

  // Lazy imports — only loaded when actually running the benchmark.
  const pg = await import('pg');
  const { bootstrapServerPostgresSchema, createPostgresStorageRepositories } = await import(
    '../../src/storage/postgres/index.js'
  );
  const { PostgresObservationRepository } = await import(
    '../../src/storage/postgres/observations.js'
  );
  const { embed } = await import('../../src/server/generation/embedder.js');

  // Wire up a scratch DB pool + schema, and seed one team (each QUESTION gets
  // its own project below, since haystack session-ids overlap across questions
  // and must not collide or leak between them).
  const pool = new pg.default.Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  await bootstrapServerPostgresSchema(client);
  const storage = createPostgresStorageRepositories(client);
  const team = await storage.teams.create({ name: 'longmemeval' });
  const teamId = team.id;
  const repo = new PostgresObservationRepository(client);

  // --- Real LongMemEval-S schema (xiaowu0162/longmemeval-cleaned) ---
  // Each item: { question_id, question_type, question, answer,
  //   answer_session_ids: string[]  (the GOLD sessions),
  //   haystack_session_ids: string[],
  //   haystack_sessions: Array<Array<{role, content}>>  (parallel to the ids) }
  // We flatten each haystack session's turns into one observation whose id is
  // the session id, then score retrieved session-ids against answer_session_ids.
  interface LmeItem {
    question_id: string;
    question_type: string;
    question: string;
    answer_session_ids: string[];
    haystack_session_ids: string[];
    haystack_sessions: Array<Array<{ role: string; content: string }>>;
  }

  const fs = await import('fs/promises');
  const raw = await fs.readFile(datasetPath, 'utf-8');
  let dataset: LmeItem[] = JSON.parse(raw);

  // The dataset is grouped by question_type, so a plain prefix (LME_LIMIT) only
  // covers the first type(s). LME_STRATIFY=N keeps every Nth item, spanning all
  // 6 types in a smaller, representative sample. LME_LIMIT caps the count.
  const strideEnv = process.env.LME_STRATIFY ? parseInt(process.env.LME_STRATIFY, 10) : 0;
  if (strideEnv > 1) dataset = dataset.filter((_, i) => i % strideEnv === 0);
  const limitEnv = process.env.LME_LIMIT ? parseInt(process.env.LME_LIMIT, 10) : 0;
  if (limitEnv > 0) dataset = dataset.slice(0, limitEnv);

  const flattenSession = (turns: Array<{ role: string; content: string }>): string =>
    turns.map(t => `${t.role}: ${t.content}`).join('\n');

  // Aggregation accumulators.
  let totalR5 = 0;
  let totalR10 = 0;
  let totalMrr = 0;
  const n = dataset.length;

  console.log(`Running LongMemEval-S on ${n} question(s)...`);

  let qi = 0;
  for (const item of dataset) {
    qi++;
    // Fresh project per question so haystacks never collide/leak.
    const project = await storage.projects.create({ teamId, name: `lme-${item.question_id}` });
    const projectId = project.id;

    // observations.id is a GLOBAL primary key and LongMemEval reuses session
    // ids across questions, so namespace the id by question to avoid cross-
    // question collisions. Gold ids are namespaced the same way for scoring.
    const nsId = (sessionId: string) => `${item.question_id}::${sessionId}`;

    // Ingest each haystack session as one observation keyed by its session id.
    // LongMemEval can list the same session id more than once within a single
    // question's haystack — dedup (first occurrence wins) since gold matching
    // is by session id and observations.id must be unique.
    const seenSessions = new Set<string>();
    for (let i = 0; i < item.haystack_session_ids.length; i++) {
      const sessionId = item.haystack_session_ids[i]!;
      if (seenSessions.has(sessionId)) continue;
      seenSessions.add(sessionId);
      const content = flattenSession(item.haystack_sessions[i] ?? []);
      if (!content.trim()) continue;
      const embeddingVec = await embed(content);
      await repo.create({ id: nsId(sessionId), projectId, teamId, content, embeddingVec });
    }

    // hybridSearch embeds the query internally and reads RRF K from
    // CLAUDE_MEM_RRF_K (default 60) via combineRanks.
    const results = await repo.hybridSearch({ projectId, teamId, query: item.question, limit: 10 });
    const retrievedIds = results.map((r: { id: string }) => r.id);
    const gold = item.answer_session_ids.map(nsId);

    const hit5 = scoreRecallAtK(retrievedIds, gold, 5);
    totalR5 += hit5;
    totalR10 += scoreRecallAtK(retrievedIds, gold, 10);
    totalMrr += mrr(retrievedIds, gold);
    console.log(`  [${qi}/${n}] ${item.question_id} [${item.question_type}] R@5=${hit5}`);
  }

  const r5 = totalR5 / n;
  const r10 = totalR10 / n;
  const mrrScore = totalMrr / n;

  console.log('\n=== LongMemEval-S Results ===');
  console.log(`Items evaluated : ${n}`);
  console.log(`R@5             : ${r5.toFixed(4)}  (PASS bar ≥ 0.90)`);
  console.log(`R@10            : ${r10.toFixed(4)}`);
  console.log(`MRR             : ${mrrScore.toFixed(4)}`);
  console.log('');

  // Release the checked-out client and close the pool BEFORE the pass/fail
  // branch — otherwise the FAIL path's process.exit(2) leaks, and an
  // unreleased client can make pool.end() hang after printing results.
  client.release();
  await pool.end();

  if (r5 >= 0.9) {
    console.log('PASS — R@5 meets the ≥ 0.90 gate. Sprint 3 is unblocked.');
  } else {
    console.log(
      'FAIL — R@5 is below 0.90. Tune RRF K, weights, or chunking and re-run.\n' +
        'If R@5 stays materially below agentmemory (0.952) after tuning, escalate\n' +
        'the build-vs-adopt decision (see SPEC §5 / PLAN §3).',
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
