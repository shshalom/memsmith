// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { decisionLog } from '../../../src/server/dashboard/queries.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('decision-log chain grouping', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }

  let pool: pg.Pool;
  let client: any;
  let schemaName: string;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_dlchain_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'chain-test-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'chain-test-project' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('groups a 3-decision chain and a standalone decision', async () => {
    const repo = new PostgresObservationRepository(client);

    // Seed a 3-decision chain: X <- Y <- Z (Z supersedes Y supersedes X)
    // Seed standalone W after the chain so W.created_at is newest overall,
    // but we control the chain to be newest by seeding W first then the chain.
    // Actually: seed X, W first (oldest), then Y, Z so Z is newest.
    // We want Z-chain first (head Z has newest created_at vs W).
    const W = await repo.create({ projectId, teamId, content: 'standalone decision W', obsType: 'decision', lifecycleState: 'resolved', metadata: {} });
    const X = await repo.create({ projectId, teamId, content: 'decision X (oldest in chain)', obsType: 'decision', lifecycleState: 'superseded', metadata: {} });
    const Y = await repo.create({ projectId, teamId, content: 'decision Y (middle in chain)', obsType: 'decision', lifecycleState: 'superseded', metadata: {}, supersedes: X.id });
    const Z = await repo.create({ projectId, teamId, content: 'decision Z (head of chain)', obsType: 'decision', lifecycleState: 'resolved', metadata: {}, supersedes: Y.id });

    const log = await decisionLog(client, { teamId, projectId });

    // Should have exactly 2 entries: the chain and the standalone
    expect(log.length).toBe(2);

    // Z-chain should be first (Z created_at > W created_at since W was seeded earlier)
    const chainEntry = log[0];
    const standaloneEntry = log[1];

    // Chain entry: head=Z, history=[X, Y] (oldest first)
    expect(chainEntry.head.id).toBe(Z.id);
    expect(chainEntry.head.content).toBe('decision Z (head of chain)');
    expect(chainEntry.history.length).toBe(2);
    expect(chainEntry.history[0].id).toBe(X.id); // oldest first
    expect(chainEntry.history[1].id).toBe(Y.id);

    // Standalone entry: head=W, history=[]
    expect(standaloneEntry.head.id).toBe(W.id);
    expect(standaloneEntry.head.content).toBe('standalone decision W');
    expect(standaloneEntry.history.length).toBe(0);
  });

  it('returns singleton chain for a single decision', async () => {
    const repo = new PostgresObservationRepository(client);
    const D = await repo.create({ projectId, teamId, content: 'lone decision', obsType: 'decision', lifecycleState: 'resolved', metadata: { why: 'testing' } });

    const log = await decisionLog(client, { teamId, projectId });

    expect(log.length).toBe(1);
    expect(log[0].head.id).toBe(D.id);
    expect(log[0].history.length).toBe(0);
    // Metadata should be parsed (not a string)
    expect(log[0].head.metadata.why).toBe('testing');
  });

  it('returns empty array when no decisions exist', async () => {
    const log = await decisionLog(client, { teamId, projectId });
    expect(log.length).toBe(0);
  });

  it('does NOT drop a decision chain whose head is a non-decision observation', async () => {
    // Scenario: decision D is superseded by a non-decision observation N (obs_type='change').
    // resolveHeads walks ALL obs_types, so it returns N.id as the chain head.
    // N is not in rowsById (only decisions are fetched), so without the fix, D is silently dropped.
    // With the fix, the code falls back to using D (newest decision member) as the displayed head.
    const repo = new PostgresObservationRepository(client);

    const D = await repo.create({
      projectId, teamId,
      content: 'decision D (superseded by a non-decision)',
      obsType: 'decision',
      lifecycleState: 'superseded',
      metadata: { rationale: 'original call' },
    });

    // N supersedes D but is NOT a decision — it's a 'change' observation.
    const N = await repo.create({
      projectId, teamId,
      content: 'change N (non-decision that supersedes D)',
      obsType: 'change',
      lifecycleState: 'resolved',
      metadata: {},
      supersedes: D.id,
    });

    const log = await decisionLog(client, { teamId, projectId });

    // D must NOT be silently dropped — it is the only decision and must appear.
    expect(log.length).toBe(1);

    // The displayed head should be D (the newest / only decision member of the chain),
    // not N (which is not a decision and is not in rowsById).
    expect(log[0].head.id).toBe(D.id);
    expect(log[0].head.content).toBe('decision D (superseded by a non-decision)');
    // Metadata must be parsed (not a raw string)
    expect(log[0].head.metadata.rationale).toBe('original call');
    // No other decision members, so history is empty
    expect(log[0].history.length).toBe(0);
  });
});
