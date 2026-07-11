// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export interface EmbeddedPostgresPaths { binariesDir: string; dataDir: string; pidFile: string; }
export interface EmbeddedPostgresInstance {
  initialize(): Promise<void>;
  start(): Promise<void>;
  waitForReady(): Promise<void>;
  getConnectionString(): string;
  stop(): Promise<void>;
}
export interface EmbeddedPostgresDriver {
  downloadBinaries(opts: { targetDir: string; variant: 'lite' }): Promise<void>;
  createServer(opts: { binariesDir: string; dataDir: string; port: number; username: string; password: string }): EmbeddedPostgresInstance;
}
export interface EmbeddedPostgresManagerOptions {
  paths?: Partial<EmbeddedPostgresPaths>;
  port?: number;
  username?: string;
  password?: string;
  driver?: EmbeddedPostgresDriver;
}

const MEMSMITH_HOME = join(homedir(), '.memsmith');

function defaultPaths(): EmbeddedPostgresPaths {
  return {
    binariesDir: join(MEMSMITH_HOME, 'pg-binaries'),
    dataDir: join(MEMSMITH_HOME, 'pgdata'),
    pidFile: join(MEMSMITH_HOME, 'local-pg.pid'),
  };
}

// The real driver adapts @boomship/postgres-vector-embedded to our interface.
// Imported lazily so the package is only loaded when local mode actually runs.
async function loadRealDriver(): Promise<EmbeddedPostgresDriver> {
  const pkg = await import('@boomship/postgres-vector-embedded');
  return {
    downloadBinaries: (opts) => pkg.downloadBinaries({ targetDir: opts.targetDir, variant: opts.variant }),
    createServer: (opts) => new pkg.PostgresServer({
      binariesDir: opts.binariesDir,
      dataDir: opts.dataDir,
      port: opts.port,
      username: opts.username,
      password: opts.password,
    }) as unknown as EmbeddedPostgresInstance,
  };
}

export class EmbeddedPostgresManager {
  readonly paths: EmbeddedPostgresPaths;
  readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly injectedDriver?: EmbeddedPostgresDriver;
  private instance: EmbeddedPostgresInstance | null = null;
  private connectionString: string | null = null;

  constructor(options: EmbeddedPostgresManagerOptions = {}) {
    this.paths = { ...defaultPaths(), ...options.paths };
    const envPort = Number.parseInt(process.env.MEMSMITH_LOCAL_PG_PORT ?? '', 10);
    this.port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 55433);
    this.username = options.username ?? 'memsmith';
    this.password = options.password ?? 'memsmith-local';
    this.injectedDriver = options.driver;
  }

  private async driver(): Promise<EmbeddedPostgresDriver> {
    return this.injectedDriver ?? (await loadRealDriver());
  }

  async ensureBinary(): Promise<void> {
    if (existsSync(this.paths.binariesDir)) {
      logger.info('SYSTEM', 'embedded PG binaries present', { dir: this.paths.binariesDir });
      return;
    }
    mkdirSync(this.paths.binariesDir, { recursive: true });
    const driver = await this.driver();
    logger.info('SYSTEM', 'downloading embedded PG binaries', { dir: this.paths.binariesDir });
    try {
      await driver.downloadBinaries({ targetDir: this.paths.binariesDir, variant: 'lite' });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `Failed to download embedded Postgres binaries into ${this.paths.binariesDir}: ${err.message}. ` +
          'Local runtime requires the embedded PG binary; check network access and platform support (darwin/linux).',
      );
    }
  }

  getConnectionString(): string {
    if (!this.connectionString) {
      throw new Error('embedded Postgres not started; call start() before getConnectionString()');
    }
    return this.connectionString;
  }

  // start()/stop() implemented in Task 2. Exposed here so Task 2 can set these:
  protected setStarted(instance: EmbeddedPostgresInstance, connectionString: string): void {
    this.instance = instance;
    this.connectionString = connectionString;
  }
  protected getInstance(): EmbeddedPostgresInstance | null { return this.instance; }
}
