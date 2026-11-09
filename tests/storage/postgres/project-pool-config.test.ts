import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePostgresConfig, projectPoolConfig } from '../../../src/storage/postgres/config.js';

const URL = 'postgres://memsmith@127.0.0.1:1/msp_x';

// Each project database gets its own pool; with ~60 projects the defaults
// (10 connections, 30 s idle, swept every 30 s) held the server at 63 of
// Postgres's 100 connections and left the CLI none.
describe('projectPoolConfig', () => {
  it('keeps each project pool small and lets idle connections close between sweeps', () => {
    const base = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: URL } })!;
    const project = projectPoolConfig(base, URL);
    expect(project.max).toBeLessThanOrEqual(3);
    expect(project.idleTimeoutMillis).toBeLessThan(30_000);
    expect(project.connectionString).toBe(URL);
  });

  it('honors a smaller operator setting', () => {
    const base = parsePostgresConfig({
      env: { MEMSMITH_SERVER_DATABASE_URL: URL, MEMSMITH_POSTGRES_POOL_MAX: '1', MEMSMITH_POSTGRES_IDLE_TIMEOUT_MS: '1000' },
    })!;
    expect(projectPoolConfig(base, URL)).toMatchObject({ max: 1, idleTimeoutMillis: 1000 });
  });

  it('is what the server uses for project databases', () => {
    const service = readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'server', 'runtime', 'create-server-service.ts'), 'utf8');
    expect(service).toContain('createPostgresPool(projectPoolConfig(config, connectionString))');
  });
});
