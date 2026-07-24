// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';

const OPT_IN = process.env.MEMSMITH_TEST_COLDBOOT === '1';
const DATA_DIR = join(tmpdir(), `ms-coldboot-${randomUUID()}`);
const PG_PORT = '55450'; // non-dogfood

describe('local cold-boot (opt-in integration)', () => {
  afterAll(() => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

  if (OPT_IN) {
    it('boots embedded PG + mints marker under a throwaway data dir', async () => {
      // HARD dogfood guard
      expect(DATA_DIR.includes('/.memsmith')).toBe(false);
      expect(PG_PORT).not.toBe('55433');

      process.env.MEMSMITH_DATA_DIR = DATA_DIR;
      process.env.MEMSMITH_LOCAL_PG_PORT = PG_PORT;
      process.env.MEMSMITH_PROJECT_CWD = DATA_DIR; // marker minted here

      const { EmbeddedPostgresManager } = await import('../../src/server/runtime/EmbeddedPostgresManager.js');
      const { startLocalRuntime } = await import('../../src/server/runtime/local-runtime.js');

      // Use a throwaway dataDir (fresh DB, guaranteed) but reuse the already-downloaded
      // binaries from the dogfood dir so no download is needed.
      const throwawayDataDir = join(DATA_DIR, 'pgdata');
      const throwawayPidFile = join(DATA_DIR, 'local-pg.pid');
      const existingBinariesDir = join(homedir(), '.memsmith', 'pg-binaries');

      const manager = new EmbeddedPostgresManager({
        paths: {
          binariesDir: existingBinariesDir,
          dataDir: throwawayDataDir,
          pidFile: throwawayPidFile,
        },
        port: Number(PG_PORT),
      });

      // Inject a minimal runImport that mints the project.json marker at
      // MEMSMITH_PROJECT_CWD without full DB operations (Ollama, SQLite migration).
      // This proves the cold-boot seam wires up correctly without requiring
      // a running Ollama instance or a pre-existing SQLite DB.
      const markerDir = join(DATA_DIR, '.memsmith');
      const runImport = async (_connectionString: string) => {
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(
          join(markerDir, 'project.json'),
          JSON.stringify({ teamId: randomUUID(), projectId: randomUUID(), note: 'coldboot-test' }, null, 2),
          'utf-8',
        );
      };

      // Boot embedded PG with throwaway paths, inject a no-op startService so the
      // test does NOT block in the server foreground loop, and inject a lightweight
      // runImport that mints the marker without full import machinery.
      const result = await startLocalRuntime({ manager, startService: async () => {}, runImport });
      expect(result.connectionString).toContain(PG_PORT);

      // marker minted at the project cwd
      expect(existsSync(join(DATA_DIR, '.memsmith', 'project.json'))).toBe(true);

      // clean shutdown of the throwaway PG
      await manager.stop();
    }, 30_000);
  }
});
