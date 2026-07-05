// SPDX-License-Identifier: Apache-2.0
//
// Shared Postgres test isolation for the SDK integration suite.
//
// Each test runs in its own schema. The pool pins `search_path` via the
// libpq `options` startup parameter, so EVERY pooled connection lands in
// that schema deterministically — the value is set in the connection
// startup packet before any query runs.
//
// This replaces the previous per-file harness, which set search_path with
// a fire-and-forget `pool.on('connect', c => c.query('SET search_path...'))`
// listener. That listener's query was not awaited, so the SDK's first
// `CREATE TABLE` (during bootstrapServerPostgresSchema) could execute on a
// freshly-acquired connection before the SET landed, intermittently failing
// with `3F000: no schema has been selected to create in`.

import pg from 'pg';
import { createHash, randomBytes } from 'crypto';

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Generate a fresh API key: the raw `cm_` token plus its sha256 hash. */
export function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Create a fresh, uniquely-named schema and return its name. The name is
 * `<prefix>_<uuid-with-underscores>`, i.e. only `[a-z0-9_]`, so it is safe
 * to interpolate into the unquoted `-c search_path=` libpq option below.
 */
export async function createIsolatedSchema(
  connectionString: string,
  prefix: string
): Promise<string> {
  const schemaName = `${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  } finally {
    await client.end();
  }
  return schemaName;
}

// Per-pool connection cap for tests. Hygiene, not a proven flake fix: the
// default pg.Pool max is 10 and ~19 test files each open a pool, so an uncapped
// worst case could approach Postgres max_connections (100 on the test
// container). Measured peak during a full `bun test` run is only ~5 (bun runs
// test FILES sequentially; only tests within a file overlap), so exhaustion is
// not actually reached today — but capping removes the latent ceiling risk and
// documents that each file needs only a couple of connections. NOTE: this does
// NOT explain the rare 5-10s socket-timeout flake on HTTP-server tests seen in
// full runs; that root cause is still unconfirmed (peak connections stayed at
// ~5 when it was reproducing), so do not treat this cap as the flake's fix.
export const TEST_POOL_MAX = 4;

/**
 * The single pg.Pool factory for tests. Always caps `max` so concurrent test
 * files can't collectively exhaust Postgres max_connections. Pass `schemaName`
 * to also pin `search_path` via the libpq startup packet (see poolForSchema).
 */
export function testPool(connectionString: string, schemaName?: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: TEST_POOL_MAX,
    ...(schemaName ? { options: `-c search_path=${schemaName}` } : {}),
  });
}

/**
 * A pool whose every connection starts with `search_path` pinned to
 * `schemaName`. Deterministic: the search_path is applied in the connection
 * startup packet, so there is no window in which a query runs before it
 * takes effect. Connection count is capped (see testPool / TEST_POOL_MAX).
 */
export function poolForSchema(connectionString: string, schemaName: string): pg.Pool {
  return testPool(connectionString, schemaName);
}

/** Drop the isolated schema and everything in it. Best-effort. */
export async function dropSchema(
  connectionString: string,
  schemaName: string
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
  } finally {
    await client.end();
  }
}
