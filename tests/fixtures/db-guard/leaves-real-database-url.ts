// Run only by tests/preload-database-guard.test.ts: a test that points the base
// database at the developer's real embedded Postgres and does not restore it.
import { it } from 'bun:test';

it('leaves MEMSMITH_SERVER_DATABASE_URL on the real local Postgres', () => {
  process.env.MEMSMITH_SERVER_DATABASE_URL = 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
});
