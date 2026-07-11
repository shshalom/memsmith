// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { isPidAlive } from '../../supervisor/process-registry.js';

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
      // Remove the dir we just created so a later run re-attempts the download
      // cleanly instead of hitting the existsSync skip-path with no binaries.
      try { rmSync(this.paths.binariesDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

  isRunning(): boolean {
    if (!existsSync(this.paths.pidFile)) return false;
    const pid = Number.parseInt(readFileSync(this.paths.pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && isPidAlive(pid);
  }

  async start(): Promise<{ connectionString: string; reused: boolean }> {
    // Reuse path: a live pid file means an instance we own is already up.
    if (this.isRunning()) {
      this.connectionString = this.buildConnectionString();
      logger.info('SYSTEM', 'embedded PG already running; reusing', { port: this.port });
      return { connectionString: this.connectionString, reused: true };
    }
    // Stale pid file (process dead) — remove it and boot fresh; PG WAL crash-recovers dataDir.
    if (existsSync(this.paths.pidFile)) {
      logger.warn('SYSTEM', 'stale embedded PG pid file; recovering', { pidFile: this.paths.pidFile });
      try { unlinkSync(this.paths.pidFile); } catch { /* best effort */ }
    }
    // Port guard: if the port is already in use by a foreign process, refuse to start.
    const { isPortInUse } = await import('../../services/infrastructure/HealthMonitor.js');
    if (await isPortInUse(this.port)) {
      throw new Error(
        `MEMSMITH_LOCAL_PG_PORT ${this.port} is in use by another process. ` +
        `Stop it or set MEMSMITH_LOCAL_PG_PORT to a free port.`,
      );
    }
    await this.ensureBinary();
    mkdirSync(this.paths.dataDir, { recursive: true });
    const driver = await this.driver();
    const instance = driver.createServer({
      binariesDir: this.paths.binariesDir,
      dataDir: this.paths.dataDir,
      port: this.port,
      username: this.username,
      password: this.password,
    });
    await instance.initialize();
    await instance.start();
    await instance.waitForReady();
    this.instance = instance;
    this.connectionString = instance.getConnectionString();
    writeFileSync(this.paths.pidFile, String(process.pid), 'utf8');
    logger.info('SYSTEM', 'embedded PG started', { port: this.port, dataDir: this.paths.dataDir });
    return { connectionString: this.connectionString, reused: false };
  }

  async stop(): Promise<void> {
    if (this.instance) {
      try { await this.instance.stop(); } catch (error) {
        logger.warn('SYSTEM', 'error stopping embedded PG', {}, error instanceof Error ? error : new Error(String(error)));
      }
      this.instance = null;
    }
    try { if (existsSync(this.paths.pidFile)) unlinkSync(this.paths.pidFile); } catch { /* best effort */ }
    this.connectionString = null;
  }

  private buildConnectionString(): string {
    return `postgres://${this.username}:${this.password}@127.0.0.1:${this.port}/postgres`;
  }
}
