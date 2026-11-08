// Run only by tests/preload-database-guard.test.ts: prints what the preload left
// in the environment for a run with the given shell variables.
import { it } from 'bun:test';

it('prints the guarded database environment', () => {
  console.log(`DB_GUARD_ENV ${JSON.stringify([
    process.env.MEMSMITH_SERVER_DATABASE_URL,
    process.env.MEMSMITH_LOCAL_PG_PORT,
    process.env.MEMSMITH_PG_BINARIES_DIR,
  ])}`);
});
