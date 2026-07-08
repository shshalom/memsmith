// SPDX-License-Identifier: Apache-2.0
//
// Live demo of the Sprint 2 retrieval path: seed a realistic observation
// corpus (with real all-MiniLM embeddings), then run hybridSearch (FTS ⊕ vector
// via RRF) for several queries and print ranked results.
//
// Run:
//   export MEMSMITH_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"
//   /Users/shwaits/.bun/bin/bun run bench/demo-hybrid-search.ts
//
// Uses a throwaway schema in the test DB and drops it on exit. Touches no live data.

import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../src/storage/postgres/observations.js';
import { embed } from '../src/server/generation/embedder.js';

const url = process.env.MEMSMITH_TEST_POSTGRES_URL;
if (!url) {
  console.error('Set MEMSMITH_TEST_POSTGRES_URL first.');
  process.exit(1);
}

const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

// A realistic mixed corpus: decisions, gotchas, tasks across several domains.
const CORPUS = [
  'Decided to use JWT access tokens with 15-minute expiry for the auth service',
  'JWT refresh token rotation happens on every use; old token is revoked',
  'Auth middleware validates the Bearer token signature against the JWKS endpoint',
  'Payment webhook retries with exponential backoff on any 5xx from Stripe',
  'Idempotency keys on the payments endpoint prevent double-charging on retry',
  'The checkout total is computed server-side; never trust the client-sent amount',
  'Postgres connection pool max is 20; raising it caused the RDS to hit max_connections',
  'We chose pgvector over a separate vector DB to keep one datastore for the team',
  'HNSW index on embeddings gives sub-10ms nearest-neighbour at our corpus size',
  'CSS grid template-areas used for the dashboard layout; flexbox for the toolbar',
  'The dark-mode toggle persists to localStorage and respects prefers-color-scheme',
  'Rate limiter uses a fixed-window counter keyed by API key in Postgres',
];

const QUERIES = [
  'how does login authentication work',
  'preventing duplicate payment charges',
  'why did we pick pgvector for storage',
  'front-end styling of the dashboard',
];

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  const schema = `cm_demo_${randomUUID().replaceAll('-', '_')}`;
  await client.query(`CREATE SCHEMA ${q(schema)}`);
  await client.query(`SET search_path TO ${q(schema)}, public`);
  await bootstrapServerPostgresSchema(client);

  const storage = createPostgresStorageRepositories(client);
  const team = await storage.teams.create({ name: 'demo-team' });
  const project = await storage.projects.create({ teamId: team.id, name: 'demo-project' });
  const repo = new PostgresObservationRepository(client);

  process.stdout.write(`Embedding + storing ${CORPUS.length} observations`);
  for (const content of CORPUS) {
    await repo.create({ projectId: project.id, teamId: team.id, content, embeddingVec: await embed(content) });
    process.stdout.write('.');
  }
  console.log(' done.\n');

  for (const query of QUERIES) {
    const results = await repo.hybridSearch({ projectId: project.id, teamId: team.id, query, limit: 3 });
    console.log(`QUERY: "${query}"`);
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r.content}`));
    console.log('');
  }

  await client.query(`DROP SCHEMA ${q(schema)} CASCADE`).catch(() => {});
  client.release();
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
