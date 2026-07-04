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
  const { randomUUID } = await import('crypto');
  const { bootstrapServerPostgresSchema, createPostgresStorageRepositories } = await import(
    '../../src/storage/postgres/index.js'
  );
  const { PostgresObservationRepository } = await import(
    '../../src/storage/postgres/observations.js'
  );
  const { embed } = await import('../../src/server/generation/embedder.js');

  // Wire up a scratch DB pool and schema.
  const pool = new pg.default.Pool({ connectionString: dbUrl });
  await bootstrapServerPostgresSchema(pool);
  const repos = createPostgresStorageRepositories(pool);
  const repo = repos.observations as InstanceType<typeof PostgresObservationRepository>;

  // --- Dataset shape expected (JSON array) ---
  // [
  //   {
  //     "id": "<item-id>",
  //     "question": "...",
  //     "gold_ids": ["<obs-id>", ...],
  //     "corpus": [
  //       { "id": "<obs-id>", "content": "...", "timestamp": "..." },
  //       ...
  //     ]
  //   },
  //   ...
  // ]

  const fs = await import('fs/promises');
  const raw = await fs.readFile(datasetPath, 'utf-8');
  const dataset: Array<{
    id: string;
    question: string;
    gold_ids: string[];
    corpus: Array<{ id: string; content: string; timestamp?: string }>;
  }> = JSON.parse(raw);

  // Scratch project for this benchmark run.
  const projectId = randomUUID();

  // Aggregation accumulators.
  let totalR5 = 0;
  let totalR10 = 0;
  let totalMrr = 0;
  const n = dataset.length;

  console.log(`Running LongMemEval-S on ${n} items (project=${projectId})…`);

  for (const item of dataset) {
    // Ingest corpus observations into the scratch project.
    for (const entry of item.corpus) {
      const embeddingVec = await embed(entry.content);
      // NOTE: create() signature may vary — adjust to match PostgresObservationRepository.create().
      // TODO: confirm exact field names once the write-path PR is merged.
      await repo.create({
        id: entry.id,
        projectId,
        content: entry.content,
        embeddingVec,
        createdAt: entry.timestamp ? new Date(entry.timestamp) : new Date(),
      } as Parameters<typeof repo.create>[0]);
    }

    // Run hybrid search for this question.
    const rrfK = process.env.CLAUDE_MEM_RRF_K ? parseInt(process.env.CLAUDE_MEM_RRF_K, 10) : 60;
    const results = await repo.hybridSearch({
      projectId,
      query: item.question,
      queryVec: await embed(item.question),
      limit: 10,
      rrfK,
    });

    const retrievedIds = results.map((r: { id: string }) => r.id);

    totalR5 += scoreRecallAtK(retrievedIds, item.gold_ids, 5);
    totalR10 += scoreRecallAtK(retrievedIds, item.gold_ids, 10);
    totalMrr += mrr(retrievedIds, item.gold_ids);
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

  await pool.end();
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
