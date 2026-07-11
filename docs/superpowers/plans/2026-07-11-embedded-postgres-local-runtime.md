# Embedded Postgres Local Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-setup `local` runtime that runs the existing server code path against an embedded Postgres+pgvector (no Docker, no Redis), so a solo user gets semantic search and every server-mode capability locally.

**Architecture:** A thin `EmbeddedPostgresManager` boots a real embedded Postgres and hands its connection string to the UNCHANGED `createServerService()`. Redis/BullMQ is replaced by an in-process `inline` queue engine (the non-Docker seam already exists). Postgres runs as a resident daemon guarded by the worker's existing pidfile machinery. First-run import reuses the proven SQLite→PG ETL, with the local Ollama model reclassifying rows into the canonical mode taxonomy.

**Tech Stack:** TypeScript, Node.js, `@boomship/postgres-vector-embedded` (PG 17.5 + pgvector 0.8.0), BullMQ (existing), `pg`, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-07-11-embedded-postgres-local-runtime-design.md`

## Global Constraints

- Every NEW `.ts` file starts with `// SPDX-License-Identifier: Apache-2.0`.
- Do NOT change the plugin default runtime (stays `worker`). `local` is opt-in via `MEMSMITH_RUNTIME=local`.
- Do NOT modify `src/storage/postgres/**` — the storage layer already consumes a connection string unchanged.
- All `@boomship/postgres-vector-embedded` contact lives inside `EmbeddedPostgresManager`. No other file imports the package.
- Reuse `src/services/infrastructure/ProcessManager.ts` for pidfile locking — do NOT invent new lock machinery.
- Reuse `scripts/migrate-claude-mem.ts` + `scripts/backfill-embeddings.ts` for import — do NOT rewrite the ETL.
- `MEMSMITH_QUEUE_ENGINE=inline` must PASS `validateServerEnv` outside Docker and be REJECTED inside Docker (Redis stays mandatory in Docker).
- Fixed loopback PG port default `55433` (var `MEMSMITH_LOCAL_PG_PORT`); never pick a random port.
- Run `npx tsc --noEmit` (0 errors) before every commit.
- Canonical taxonomy is loaded from the ACTIVE mode's `observation_types` at runtime, never hardcoded. The `code` mode's 8 types: `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`, `security_alert`, `security_note`. Invalid model output falls back to `change`.
- Keep-list deps (claude-code / claude-agent / @anthropic-ai) are never renamed.
- End git commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Add embedded-PG dependency + `EmbeddedPostgresManager` (binary + connection)

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/server/runtime/EmbeddedPostgresManager.ts`
- Test: `tests/server/embedded-postgres-manager.test.ts`

**Interfaces:**
- Consumes: `ProcessManager` pidfile utils (`writePidFile`, `readPidFile`, `removePidFileIfOwner`, `isProcessAlive` — signatures confirmed in `src/services/infrastructure/ProcessManager.ts`).
- Produces:
  ```ts
  export interface EmbeddedPostgresPaths {
    binariesDir: string;   // ~/.memsmith/pg-binaries
    dataDir: string;       // ~/.memsmith/pgdata
    pidFile: string;       // ~/.memsmith/local-pg.pid
  }
  export interface EmbeddedPostgresManagerOptions {
    paths?: Partial<EmbeddedPostgresPaths>;
    port?: number;                 // default 55433 or MEMSMITH_LOCAL_PG_PORT
    username?: string;             // default 'memsmith'
    password?: string;             // default 'memsmith-local'
    // Test seam: inject a fake PG driver so tests never download/boot a real server.
    driver?: EmbeddedPostgresDriver;
  }
  export interface EmbeddedPostgresDriver {
    downloadBinaries(opts: { targetDir: string; variant: 'lite' }): Promise<void>;
    createServer(opts: { binariesDir: string; dataDir: string; port: number; username: string; password: string }): EmbeddedPostgresInstance;
  }
  export interface EmbeddedPostgresInstance {
    initialize(): Promise<void>;
    start(): Promise<void>;
    waitForReady(): Promise<void>;
    getConnectionString(): string;
    stop(): Promise<void>;
  }
  export class EmbeddedPostgresManager {
    constructor(options?: EmbeddedPostgresManagerOptions);
    ensureBinary(): Promise<void>;                 // download-once, skip if present
    getConnectionString(): string;                  // throws if not started
    // start()/stop()/port live in Task 2; this task only does binary + conn-string plumbing.
  }
  ```

- [ ] **Step 1: Add the dependency**

Run: `npm install @boomship/postgres-vector-embedded@0.2.2`
Expected: `package.json` gains `"@boomship/postgres-vector-embedded": "^0.2.2"` under dependencies; `package-lock.json` updated.

- [ ] **Step 2: Write the failing test**

```ts
// tests/server/embedded-postgres-manager.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeDriver() {
  const calls: string[] = [];
  const instance = {
    initialize: async () => { calls.push('initialize'); },
    start: async () => { calls.push('start'); },
    waitForReady: async () => { calls.push('waitForReady'); },
    getConnectionString: () => 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    stop: async () => { calls.push('stop'); },
  };
  const driver = {
    downloadBinaries: async () => { calls.push('download'); },
    createServer: () => instance,
  };
  return { driver, instance, calls };
}

describe('EmbeddedPostgresManager', () => {
  it('ensureBinary downloads once', async () => {
    const { driver, calls } = fakeDriver();
    const mgr = new EmbeddedPostgresManager({ driver, paths: { binariesDir: '/tmp/does-not-exist-memsmith-test' } });
    await mgr.ensureBinary();
    expect(calls).toContain('download');
  });

  it('getConnectionString throws before start', () => {
    const { driver } = fakeDriver();
    const mgr = new EmbeddedPostgresManager({ driver });
    expect(() => mgr.getConnectionString()).toThrow(/not started/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/embedded-postgres-manager.test.ts`
Expected: FAIL — `Cannot find module '.../EmbeddedPostgresManager.js'`.

- [ ] **Step 4: Implement the manager (binary + conn-string only)**

```ts
// src/server/runtime/EmbeddedPostgresManager.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/embedded-postgres-manager.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add package.json package-lock.json src/server/runtime/EmbeddedPostgresManager.ts tests/server/embedded-postgres-manager.test.ts
git commit -m "feat(local): EmbeddedPostgresManager binary+conn-string plumbing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `EmbeddedPostgresManager` lifecycle — start/stop/reuse with pidfile + port

**Files:**
- Modify: `src/server/runtime/EmbeddedPostgresManager.ts`
- Test: `tests/server/embedded-postgres-lifecycle.test.ts`

**Interfaces:**
- Consumes: the `EmbeddedPostgresInstance` + `EmbeddedPostgresDriver` from Task 1; a small pidfile helper set (inline in this file, mirroring `ProcessManager` semantics — `isProcessAlive(pid)` is available from `../../services/infrastructure/ProcessManager.js`).
- Produces:
  ```ts
  // added to EmbeddedPostgresManager:
  start(): Promise<{ connectionString: string; reused: boolean }>;
  stop(): Promise<void>;
  isRunning(): boolean;  // pid file exists AND process alive
  ```

- [ ] **Step 1: Confirm `isProcessAlive` export**

Run: `grep -n "export function isProcessAlive" src/services/infrastructure/ProcessManager.ts`
Expected: one match. (If the export name differs, use the actual exported alive-check and adjust imports below.)

- [ ] **Step 2: Write the failing test**

```ts
// tests/server/embedded-postgres-lifecycle.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

const TMP = join(tmpdir(), 'memsmith-pg-lifecycle-test');

function fakeDriver() {
  const instance = {
    initialize: async () => {},
    start: async () => {},
    waitForReady: async () => {},
    getConnectionString: () => 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    stop: async () => {},
  };
  return { downloadBinaries: async () => {}, createServer: () => instance };
}

afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('EmbeddedPostgresManager lifecycle', () => {
  it('start writes a pid file and returns a connection string', async () => {
    const mgr = new EmbeddedPostgresManager({
      driver: fakeDriver(),
      paths: { binariesDir: join(TMP, 'bin'), dataDir: join(TMP, 'data'), pidFile: join(TMP, 'pg.pid') },
    });
    const res = await mgr.start();
    expect(res.connectionString).toContain('postgres://');
    expect(res.reused).toBe(false);
    expect(existsSync(join(TMP, 'pg.pid'))).toBe(true);
  });

  it('second start with a live pid reuses instead of re-initializing', async () => {
    const paths = { binariesDir: join(TMP, 'bin'), dataDir: join(TMP, 'data'), pidFile: join(TMP, 'pg.pid') };
    const mgr1 = new EmbeddedPostgresManager({ driver: fakeDriver(), paths });
    await mgr1.start();
    // The pid file holds THIS test process's pid (alive), so a fresh manager should reuse.
    const mgr2 = new EmbeddedPostgresManager({ driver: fakeDriver(), paths });
    const res2 = await mgr2.start();
    expect(res2.reused).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/embedded-postgres-lifecycle.test.ts`
Expected: FAIL — `mgr.start is not a function`.

- [ ] **Step 4: Implement start/stop/reuse**

Add these imports at the top of `EmbeddedPostgresManager.ts`:

```ts
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { isProcessAlive } from '../../services/infrastructure/ProcessManager.js';
```

Add the methods to the class (replace the `setStarted`/`getInstance` protected stubs from Task 1 with these public methods):

```ts
  isRunning(): boolean {
    if (!existsSync(this.paths.pidFile)) return false;
    const pid = Number.parseInt(readFileSync(this.paths.pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && isProcessAlive(pid);
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
```

Remove the `protected setStarted`/`getInstance` stubs and change `private instance`/`private connectionString` to stay as class fields (already declared in Task 1).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/embedded-postgres-lifecycle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/server/runtime/EmbeddedPostgresManager.ts tests/server/embedded-postgres-lifecycle.test.ts
git commit -m "feat(local): embedded PG start/stop/reuse with pidfile + fixed port

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Accept `inline` queue engine in config + env validation

**Files:**
- Modify: `src/server/queue/redis-config.ts:9,22-27`
- Modify: `src/server/runtime/create-server-service.ts:123-132`
- Test: `tests/server/inline-queue-config.test.ts`

**Interfaces:**
- Produces: `ObservationQueueEngineName` widened to `'sqlite' | 'bullmq' | 'inline'`; `getObservationQueueEngineName()` accepts `inline`; `validateServerEnv` allows `inline` outside Docker, rejects inside Docker.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/inline-queue-config.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { validateServerEnv } from '../../src/server/runtime/create-server-service.js';

const base = {
  MEMSMITH_SERVER_DATABASE_URL: 'postgres://x:y@127.0.0.1:55433/postgres',
  MEMSMITH_RUNTIME: 'local',
};

describe('inline queue engine', () => {
  it('is allowed outside Docker', () => {
    expect(() => validateServerEnv({ isDocker: false, env: { ...base, MEMSMITH_QUEUE_ENGINE: 'inline' } as any }))
      .not.toThrow();
  });
  it('is rejected inside Docker', () => {
    expect(() => validateServerEnv({ isDocker: true, env: { ...base, MEMSMITH_RUNTIME: 'server', MEMSMITH_QUEUE_ENGINE: 'inline', MEMSMITH_REDIS_URL: 'redis://x' } as any }))
      .toThrow(/only "bullmq" is supported/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/inline-queue-config.test.ts`
Expected: FAIL — the outside-Docker case throws `Invalid MEMSMITH_QUEUE_ENGINE=inline` from `getObservationQueueEngineName` (called indirectly), or the not-toThrow assertion fails.

- [ ] **Step 3: Widen the engine type + validator in `redis-config.ts`**

At `src/server/queue/redis-config.ts:9`, change:
```ts
export type ObservationQueueEngineName = 'sqlite' | 'bullmq' | 'inline';
```
At `:22-27`, change `getObservationQueueEngineName`:
```ts
export function getObservationQueueEngineName(): ObservationQueueEngineName {
  const raw = getQueueSetting('MEMSMITH_QUEUE_ENGINE').trim().toLowerCase();
  if (raw === 'sqlite' || raw === 'bullmq' || raw === 'inline') {
    return raw;
  }
  throw new Error(`Invalid MEMSMITH_QUEUE_ENGINE=${raw}; expected sqlite, bullmq, or inline`);
}
```

- [ ] **Step 4: Confirm `validateServerEnv` already handles inline outside Docker**

The Docker branch at `create-server-service.ts:124-132` only rejects non-bullmq WHEN `isDocker`. Outside Docker there is no engine check, so `inline` already passes. Verify no other line rejects it:

Run: `grep -n "queueEngine" src/server/runtime/create-server-service.ts`
Expected: the only rejection of non-bullmq is inside the `if (isDocker)` block. No change needed to the validator body — but confirm line 140 (`queueEngine === 'bullmq' && !hasRedisUrl`) does NOT fire for inline (it is guarded by `=== 'bullmq'`, so inline is exempt). Good.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/inline-queue-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors. (If TS flags exhaustiveness on `ObservationQueueEngineName` elsewhere, add the `inline` arm — search `grep -rn "engine === 'sqlite'\|engine === 'bullmq'" src/server` and handle any switch that must account for it.)

```bash
git add src/server/queue/redis-config.ts tests/server/inline-queue-config.test.ts
git commit -m "feat(local): accept MEMSMITH_QUEUE_ENGINE=inline (non-Docker only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `InlineServerQueue` — in-memory queue implementing the ServerJobQueue surface

**Files:**
- Create: `src/server/runtime/InlineServerQueue.ts`
- Test: `tests/server/inline-server-queue.test.ts`

**Interfaces:**
- Consumes: `ServerJobObservedListener`, `ServerJobCounts`, `ServerJobLifecycleCounters` (from `../jobs/ServerJobQueue.js`); `Processor`, `Job` conceptually (we build a minimal Job-shaped object).
- Produces:
  ```ts
  export class InlineServerQueue<TPayload extends object = object> {
    constructor(name: string, concurrency?: number);
    add(jobId: string, payload: TPayload): Promise<void>;   // enqueue + schedule drain
    start(processor: (job: { id: string; data: TPayload; attemptsMade: number }) => Promise<unknown>): void;
    getCounts(): Promise<ServerJobCounts>;
    observe(listener: ServerJobObservedListener): void;
    getLifecycleCounters(): ServerJobLifecycleCounters;
    isStarted(): boolean;
    close(): Promise<void>;
  }
  ```
  The processor receives a minimal Job-shaped object (`{ id, data, attemptsMade }`) — the generation dispatcher (`ActiveServerGenerationWorkerManager.start`) only reads `job.id`, `job.data`, `job.attemptsMade`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/inline-server-queue.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { InlineServerQueue } from '../../src/server/runtime/InlineServerQueue.js';

async function flush() { await new Promise((r) => setTimeout(r, 20)); }

describe('InlineServerQueue', () => {
  it('drains enqueued jobs through the processor', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    const seen: number[] = [];
    q.start(async (job) => { seen.push(job.data.n); });
    await q.add('a', { n: 1 });
    await q.add('b', { n: 2 });
    await flush();
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('reports completed count and fires onCompleted', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    let completed = 0;
    q.observe({ onCompleted: () => { completed += 1; } });
    q.start(async () => {});
    await q.add('a', { n: 1 });
    await flush();
    const counts = await q.getCounts();
    expect(counts.completed).toBe(1);
    expect(completed).toBe(1);
  });

  it('a throwing processor increments failed and does not crash', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    let failed = 0;
    q.observe({ onFailed: () => { failed += 1; } });
    q.start(async () => { throw new Error('boom'); });
    await q.add('a', { n: 1 });
    await flush();
    const counts = await q.getCounts();
    expect(counts.failed).toBe(1);
    expect(failed).toBe(1);
  });

  it('start twice throws', () => {
    const q = new InlineServerQueue('event');
    q.start(async () => {});
    expect(() => q.start(async () => {})).toThrow(/already started/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/inline-server-queue.test.ts`
Expected: FAIL — `Cannot find module '.../InlineServerQueue.js'`.

- [ ] **Step 3: Implement the inline queue**

```ts
// src/server/runtime/InlineServerQueue.ts
// SPDX-License-Identifier: Apache-2.0
import { logger } from '../../utils/logger.js';
import type {
  ServerJobCounts,
  ServerJobLifecycleCounters,
  ServerJobObservedListener,
} from '../jobs/ServerJobQueue.js';

type InlineJob<TPayload> = { id: string; data: TPayload; attemptsMade: number };
type InlineProcessor<TPayload> = (job: InlineJob<TPayload>) => Promise<unknown>;

// In-process, in-memory queue. Local runtime only (single process, single
// user). No durability: jobs are lost on process death — acceptable because
// generation is best-effort and re-derivable from the raw session.
export class InlineServerQueue<TPayload extends object = object> {
  private readonly waiting: InlineJob<TPayload>[] = [];
  private active = 0;
  private completed = 0;
  private failed = 0;
  private started = false;
  private closed = false;
  private processor: InlineProcessor<TPayload> | null = null;
  private readonly listeners: ServerJobObservedListener[] = [];
  private readonly counters: ServerJobLifecycleCounters = { stalled: 0, errored: 0 };

  constructor(readonly name: string, private readonly concurrency: number = 1) {}

  async add(jobId: string, payload: TPayload): Promise<void> {
    if (this.closed) throw new Error(`InlineServerQueue ${this.name} is closed`);
    this.waiting.push({ id: jobId, data: payload, attemptsMade: 0 });
    queueMicrotask(() => this.drain());
  }

  start(processor: InlineProcessor<TPayload>): void {
    if (this.started) throw new Error(`InlineServerQueue ${this.name} is already started`);
    this.processor = processor;
    this.started = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (!this.processor || this.closed) return;
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.active += 1;
      const startedAt = Date.now();
      void this.processor(job)
        .then((returnvalue) => {
          this.completed += 1;
          const durationMs = Date.now() - startedAt;
          for (const l of this.listeners) {
            try { l.onCompleted?.(job.id, durationMs, returnvalue); } catch { /* isolate */ }
          }
        })
        .catch((error: unknown) => {
          this.failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn('QUEUE', `[inline] job=${job.id} failed`, { queue: this.name, reason });
          for (const l of this.listeners) {
            try { l.onFailed?.(job.id, job.attemptsMade, reason); } catch { /* isolate */ }
          }
        })
        .finally(() => {
          this.active -= 1;
          if (this.waiting.length > 0) queueMicrotask(() => this.drain());
        });
    }
  }

  async getCounts(): Promise<ServerJobCounts> {
    return { waiting: this.waiting.length, active: this.active, delayed: 0, failed: this.failed, completed: this.completed };
  }

  observe(listener: ServerJobObservedListener): void { this.listeners.push(listener); }
  getLifecycleCounters(): ServerJobLifecycleCounters { return { ...this.counters }; }
  isStarted(): boolean { return this.started; }

  async close(): Promise<void> {
    this.closed = true;
    this.waiting.length = 0;
    this.processor = null;
    this.started = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/inline-server-queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/server/runtime/InlineServerQueue.ts tests/server/inline-server-queue.test.ts
git commit -m "feat(local): InlineServerQueue in-memory queue (ServerJobQueue surface)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `InlineServerQueueManager` + wire it into `buildQueueManager`/`buildGenerationWorkerManager`

**Files:**
- Create: `src/server/runtime/InlineServerQueueManager.ts`
- Modify: `src/server/runtime/ActiveServerGenerationWorkerManager.ts:12,30,102` (widen queue-manager type)
- Modify: `src/server/runtime/create-server-service.ts:232-241,330-338` (build inline manager + accept it)
- Test: `tests/server/inline-queue-manager.test.ts`

**Interfaces:**
- Consumes: `InlineServerQueue` (Task 4); `ServerGenerationJobKind`, `ServerGenerationJobPayload` (`../jobs/types.js`); `SERVER_JOB_QUEUE_NAMES` (`../jobs/types.js`); `ServerQueueManager`, `ServerBoundaryHealth`, `ServerQueueLaneMetric` (`./types.js`).
- Produces:
  ```ts
  // A shared structural type both managers satisfy (add to ./types.ts):
  export interface ServerGenerationQueueManager extends ServerQueueManager {
    start(kind: ServerGenerationJobKind, processor: (job: { id: string; data: ServerGenerationJobPayload; attemptsMade: number }) => Promise<unknown>): void;
    getQueue(kind: ServerGenerationJobKind): { observe(listener: ServerJobObservedListener): void };
  }
  export class InlineServerQueueManager implements ServerGenerationQueueManager { /* ... */ }
  ```
  `ActiveServerGenerationWorkerManagerOptions.queueManager` retyped from `ActiveServerQueueManager` to `ServerGenerationQueueManager`.

- [ ] **Step 1: Add the shared interface to `types.ts`**

In `src/server/runtime/types.ts`, after the `ServerQueueManager` interface (line 45), add (import the referenced types at top of file):
```ts
import type { ServerGenerationJobKind, ServerGenerationJobPayload } from '../jobs/types.js';
import type { ServerJobObservedListener } from '../jobs/ServerJobQueue.js';

export interface ServerGenerationQueueManager extends ServerQueueManager {
  start(
    kind: ServerGenerationJobKind,
    processor: (job: { id: string; data: ServerGenerationJobPayload; attemptsMade: number }) => Promise<unknown>,
  ): void;
  getQueue(kind: ServerGenerationJobKind): { observe(listener: ServerJobObservedListener): void };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/server/inline-queue-manager.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { InlineServerQueueManager } from '../../src/server/runtime/InlineServerQueueManager.js';

describe('InlineServerQueueManager', () => {
  it('reports active health with engine inline', () => {
    const m = new InlineServerQueueManager();
    const h = m.getHealth();
    expect(h.status).toBe('active');
    expect((h.details as any).engine).toBe('inline');
  });
  it('start dispatches jobs added to a lane', async () => {
    const m = new InlineServerQueueManager();
    const seen: string[] = [];
    m.start('event', async (job) => { seen.push(job.id); });
    await m.getQueueForTest('event').add('j1', { kind: 'event' } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['j1']);
  });
  it('getQueue exposes observe', () => {
    const m = new InlineServerQueueManager();
    expect(typeof m.getQueue('event').observe).toBe('function');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/inline-queue-manager.test.ts`
Expected: FAIL — `Cannot find module '.../InlineServerQueueManager.js'`.

- [ ] **Step 4: Implement the manager**

```ts
// src/server/runtime/InlineServerQueueManager.ts
// SPDX-License-Identifier: Apache-2.0
import { InlineServerQueue } from './InlineServerQueue.js';
import {
  SERVER_JOB_QUEUE_NAMES,
  type ServerGenerationJobKind,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import type {
  ServerBoundaryHealth,
  ServerGenerationQueueManager,
  ServerQueueLaneMetric,
} from './types.js';

const QUEUE_KINDS: ServerGenerationJobKind[] = ['event', 'summary'];

export class InlineServerQueueManager implements ServerGenerationQueueManager {
  readonly kind = 'queue-manager' as const;
  private readonly queues: Map<ServerGenerationJobKind, InlineServerQueue<ServerGenerationJobPayload>>;
  private closed = false;

  constructor() {
    this.queues = new Map();
    for (const k of QUEUE_KINDS) this.queues.set(k, new InlineServerQueue<ServerGenerationJobPayload>(SERVER_JOB_QUEUE_NAMES[k]));
  }

  getQueue(kind: ServerGenerationJobKind): InlineServerQueue<ServerGenerationJobPayload> {
    const q = this.queues.get(kind);
    if (!q) throw new Error(`unknown server generation job kind: ${kind}`);
    return q;
  }
  // test alias to keep the test explicit; getQueue already returns the queue.
  getQueueForTest(kind: ServerGenerationJobKind): InlineServerQueue<ServerGenerationJobPayload> { return this.getQueue(kind); }

  start(
    kind: ServerGenerationJobKind,
    processor: (job: { id: string; data: ServerGenerationJobPayload; attemptsMade: number }) => Promise<unknown>,
  ): void {
    this.getQueue(kind).start(processor);
  }

  getHealth(): ServerBoundaryHealth {
    if (this.closed) return { status: 'errored', reason: 'queue-manager closed' };
    return {
      status: 'active',
      reason: 'in-process inline queue (local runtime)',
      details: { engine: 'inline', mode: 'in-process', lanes: QUEUE_KINDS.map((k) => ({ kind: k, name: SERVER_JOB_QUEUE_NAMES[k] })) },
    };
  }

  async getLaneMetrics(): Promise<ServerQueueLaneMetric[]> {
    const out: ServerQueueLaneMetric[] = [];
    for (const kind of QUEUE_KINDS) {
      const q = this.queues.get(kind);
      if (!q) continue;
      const c = await q.getCounts();
      out.push({ kind, name: SERVER_JOB_QUEUE_NAMES[kind], waiting: c.waiting, active: c.active, completed: c.completed, failed: c.failed, delayed: c.delayed, stalled: 0, unavailable: false });
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.queues.values()) await q.close();
  }
}
```

- [ ] **Step 5: Widen the worker-manager type**

In `src/server/runtime/ActiveServerGenerationWorkerManager.ts`:
- Line 12: replace `import type { ActiveServerQueueManager } from './ActiveServerQueueManager.js';` with `import type { ServerGenerationQueueManager } from './types.js';`
- Line 30: `queueManager: ServerGenerationQueueManager;`
- No change needed at line 89/94/102 — `start(...)` and `getQueue(...)` are on the shared interface.

- [ ] **Step 6: Wire `buildQueueManager` + `buildGenerationWorkerManager` in `create-server-service.ts`**

At `buildQueueManager()` (line 330), insert before the disabled fallback:
```ts
function buildQueueManager(): ServerQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine === 'inline') {
    return new InlineServerQueueManager();
  }
  if (config.engine !== 'bullmq') {
    return new DisabledServerQueueManager(
      `Queue engine is "${config.engine}"; set MEMSMITH_QUEUE_ENGINE=bullmq to activate the server queue manager.`,
    );
  }
  return new ActiveServerQueueManager(config);
}
```
Add the import at the top of the file: `import { InlineServerQueueManager } from './InlineServerQueueManager.js';`

At `buildGenerationWorkerManager()` (line 237), widen the disabling guard:
```ts
  if (!(queueManager instanceof ActiveServerQueueManager) && !(queueManager instanceof InlineServerQueueManager)) {
    return new DisabledServerGenerationWorkerManager(
      'queue manager is disabled; set MEMSMITH_QUEUE_ENGINE=bullmq or inline to enable provider generation.',
    );
  }
```
The `ActiveServerGenerationWorkerManager` constructor call below passes `queueManager` — its type is now `ServerGenerationQueueManager`, which both concrete managers satisfy. If TS complains the param is `ServerQueueManager`, cast at the call site: `queueManager as ServerGenerationQueueManager` (safe: guarded by the instanceof above).

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/server/inline-queue-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Typecheck + no-regression + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `bun test tests/server/inline-server-queue.test.ts tests/server/inline-queue-config.test.ts`
Expected: all green.

```bash
git add src/server/runtime/InlineServerQueueManager.ts src/server/runtime/types.ts src/server/runtime/ActiveServerGenerationWorkerManager.ts src/server/runtime/create-server-service.ts tests/server/inline-queue-manager.test.ts
git commit -m "feat(local): wire inline queue manager into server runtime factory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `local` runtime entrypoint — boot embedded PG, then run the server foreground

**Files:**
- Create: `src/server/runtime/local-runtime.ts`
- Modify: `src/server/runtime/ServerService.ts:440-454` (extract a reusable foreground runner the local entry can call)
- Test: `tests/server/local-runtime.test.ts`

**Interfaces:**
- Consumes: `EmbeddedPostgresManager` (Task 2); `createServerService` (existing).
- Produces:
  ```ts
  export async function startLocalRuntime(opts?: { manager?: EmbeddedPostgresManager; startService?: (conn: string) => Promise<void> }): Promise<{ connectionString: string }>;
  ```
  `startLocalRuntime` ensures PG is up, sets `process.env.MEMSMITH_SERVER_DATABASE_URL` + `MEMSMITH_QUEUE_ENGINE='inline'` (if unset), then invokes the service starter.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/local-runtime.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { startLocalRuntime } from '../../src/server/runtime/local-runtime.js';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeManager(conn: string): EmbeddedPostgresManager {
  return {
    start: async () => ({ connectionString: conn, reused: false }),
    getConnectionString: () => conn,
    stop: async () => {},
    isRunning: () => false,
  } as unknown as EmbeddedPostgresManager;
}

describe('startLocalRuntime', () => {
  it('sets DATABASE_URL + inline engine and calls the service starter', async () => {
    const conn = 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
    delete process.env.MEMSMITH_QUEUE_ENGINE;
    let startedWith: string | null = null;
    await startLocalRuntime({ manager: fakeManager(conn), startService: async (c) => { startedWith = c; } });
    expect(startedWith).toBe(conn);
    expect(process.env.MEMSMITH_SERVER_DATABASE_URL).toBe(conn);
    expect(process.env.MEMSMITH_QUEUE_ENGINE).toBe('inline');
  });

  it('does not override an explicitly set queue engine', async () => {
    process.env.MEMSMITH_QUEUE_ENGINE = 'bullmq';
    const conn = 'postgres://x:y@127.0.0.1:55433/postgres';
    await startLocalRuntime({ manager: fakeManager(conn), startService: async () => {} });
    expect(process.env.MEMSMITH_QUEUE_ENGINE).toBe('bullmq');
    delete process.env.MEMSMITH_QUEUE_ENGINE;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/local-runtime.test.ts`
Expected: FAIL — `Cannot find module '.../local-runtime.js'`.

- [ ] **Step 3: Implement the local entrypoint**

```ts
// src/server/runtime/local-runtime.ts
// SPDX-License-Identifier: Apache-2.0
import { EmbeddedPostgresManager } from './EmbeddedPostgresManager.js';
import { logger } from '../../utils/logger.js';

export interface StartLocalRuntimeOptions {
  manager?: EmbeddedPostgresManager;
  // Injectable so tests don't boot the HTTP server. Defaults to the real
  // server foreground runner.
  startService?: (connectionString: string) => Promise<void>;
}

export async function startLocalRuntime(
  options: StartLocalRuntimeOptions = {},
): Promise<{ connectionString: string }> {
  const manager = options.manager ?? new EmbeddedPostgresManager();
  const { connectionString, reused } = await manager.start();
  process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString;
  if (!(process.env.MEMSMITH_QUEUE_ENGINE ?? '').trim()) {
    process.env.MEMSMITH_QUEUE_ENGINE = 'inline';
  }
  logger.info('SYSTEM', 'local runtime: embedded PG ready', { reused });
  const start = options.startService ?? defaultStartService;
  await start(connectionString);
  return { connectionString };
}

async function defaultStartService(_connectionString: string): Promise<void> {
  // Reuse the existing server foreground loop; it reads MEMSMITH_SERVER_DATABASE_URL
  // (which we just set) and installs signal handlers + createServerService.
  const { runServerForegroundForLocal } = await import('./ServerService.js');
  await runServerForegroundForLocal();
}
```

- [ ] **Step 4: Export a reusable foreground runner from `ServerService.ts`**

In `src/server/runtime/ServerService.ts`, the existing `runServerForeground(port, host)` (line 440) is not exported and takes port/host. Add a thin exported wrapper that resolves the default port/host the same way `server start` does (find how `runServerForeground` is currently called — near line 430 — and mirror that port/host resolution):
```ts
// Exported for the local runtime, which boots embedded PG then runs the same
// foreground service loop. Mirrors the `server start` port/host defaults.
export async function runServerForegroundForLocal(): Promise<void> {
  const port = resolveServerPort();   // reuse whatever `server start` uses
  const host = resolveServerHost();   // reuse whatever `server start` uses
  await runServerForeground(port, host);
}
```
If `resolveServerPort`/`resolveServerHost` helpers don't exist, inline the same literals the existing `server start` path passes to `runServerForeground` (read lines around 420–435 to copy them verbatim — do NOT invent new defaults).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/local-runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/server/runtime/local-runtime.ts src/server/runtime/ServerService.ts tests/server/local-runtime.test.ts
git commit -m "feat(local): local runtime entrypoint boots embedded PG then server loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: CLI dispatch — `local start` / `local stop` / `local status`

**Files:**
- Modify: `src/services/worker-service.ts:804-831` (`parseWorkerServiceCommand` — add `local` branch)
- Modify: `src/services/worker-service.ts` (command handler — dispatch `local-*` to the local runtime)
- Test: `tests/worker/parse-local-command.test.ts`

**Interfaces:**
- Consumes: `parseWorkerServiceCommand(argv): { command, args }` (existing).
- Produces: `local start|stop|status` parse to `local-start|local-stop|local-status`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/worker/parse-local-command.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { parseWorkerServiceCommand } from '../../src/services/worker-service.js';

describe('parseWorkerServiceCommand local', () => {
  it('maps local start', () => {
    expect(parseWorkerServiceCommand(['local', 'start'])).toEqual({ command: 'local-start', args: [] });
  });
  it('maps local stop', () => {
    expect(parseWorkerServiceCommand(['local', 'stop'])).toEqual({ command: 'local-stop', args: [] });
  });
  it('unknown local subcommand → local-help', () => {
    expect(parseWorkerServiceCommand(['local', 'wat'])).toEqual({ command: 'local-help', args: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/parse-local-command.test.ts`
Expected: FAIL — returns `{ command: 'local', args: ['start'] }` (falls through to the generic branch).

- [ ] **Step 3: Add the `local` branch to `parseWorkerServiceCommand`**

In `src/services/worker-service.ts`, after the `worker` branch (line 825), before the final return:
```ts
  if (rawCommand === 'local') {
    const localAliases = new Set(['start', 'stop', 'status', 'restart']);
    return {
      command: maybeSubCommand && localAliases.has(maybeSubCommand) ? `local-${maybeSubCommand}` : 'local-help',
      args: rest,
    };
  }
```

- [ ] **Step 4: Wire the command handlers**

Find the switch/if-chain that dispatches parsed commands (search `grep -n "case 'server-start'\|command === 'worker-start'\|'server-help'" src/services/worker-service.ts`). Add handlers mirroring how `server-start` dispatches, but calling the local runtime:
```ts
  if (command === 'local-start') {
    process.env.MEMSMITH_RUNTIME = 'local';
    const { startLocalRuntime } = await import('../server/runtime/local-runtime.js');
    await startLocalRuntime();   // blocks in the foreground server loop
    return;
  }
  if (command === 'local-stop') {
    const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
    await new EmbeddedPostgresManager().stop();
    console.log('Local embedded Postgres stopped.');
    return;
  }
  if (command === 'local-status') {
    const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
    const running = new EmbeddedPostgresManager().isRunning();
    console.log(running ? 'Local embedded Postgres: RUNNING' : 'Local embedded Postgres: stopped');
    return;
  }
  if (command === 'local-help') {
    console.error('Usage: worker-service local start|stop|status');
    process.exit(1);
  }
```
Place these near the existing `server-*` handlers so import style and control flow match.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/worker/parse-local-command.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/services/worker-service.ts tests/worker/parse-local-command.test.ts
git commit -m "feat(local): CLI dispatch for local start|stop|status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Taxonomy-aware classifier for the first-run importer

**Files:**
- Create: `src/server/runtime/import/classifyObservationType.ts`
- Test: `tests/server/classify-observation-type.test.ts`

**Interfaces:**
- Consumes: the active mode's `observation_types` (loaded via the same fallback pattern as `src/server/generation/providers/shared/prompt-builder.ts:148` `loadActiveModeOrFallback`); an injectable classifier fn (the local Ollama call) so tests stay offline.
- Produces:
  ```ts
  export interface TaxonomyClassifier {
    // Returns a canonical obs_type id, or null if it cannot decide.
    classify(input: { content: string; sourceType: string }): Promise<string | null>;
  }
  export function loadCanonicalTypeIds(): string[];   // from active mode, fallback list
  export async function resolveObsType(args: {
    content: string;
    sourceType: string;
    canonical: string[];
    classifier: TaxonomyClassifier;
  }): Promise<string>;   // valid canonical id, or 'change' fallback
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/classify-observation-type.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { resolveObsType } from '../../src/server/runtime/import/classifyObservationType.js';

const CANON = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'security_alert', 'security_note'];
const never = { classify: async () => { throw new Error('should not be called'); } };

describe('resolveObsType', () => {
  it('keeps a source type that is already canonical (no model call)', async () => {
    const t = await resolveObsType({ content: 'x', sourceType: 'decision', canonical: CANON, classifier: never });
    expect(t).toBe('decision');
  });
  it('classifies an unknown source type via the model', async () => {
    const classifier = { classify: async () => 'feature' };
    const t = await resolveObsType({ content: 'added a thing', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('feature');
  });
  it('falls back to change when the model returns an invalid label', async () => {
    const classifier = { classify: async () => 'nonsense-type' };
    const t = await resolveObsType({ content: 'x', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('change');
  });
  it('falls back to change when the model errors or returns null', async () => {
    const classifier = { classify: async () => null };
    const t = await resolveObsType({ content: 'x', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('change');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/classify-observation-type.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier resolver**

```ts
// src/server/runtime/import/classifyObservationType.ts
// SPDX-License-Identifier: Apache-2.0
import { ModeManager } from '../../../services/domain/ModeManager.js';
import { logger } from '../../../utils/logger.js';

const FALLBACK_TYPE = 'change';

export interface TaxonomyClassifier {
  classify(input: { content: string; sourceType: string }): Promise<string | null>;
}

export function loadCanonicalTypeIds(): string[] {
  try {
    const mode = ModeManager.getInstance().getActiveMode() as { observation_types?: Array<{ id: string }> };
    const ids = (mode.observation_types ?? []).map((t) => t.id).filter(Boolean);
    if (ids.length > 0) return ids;
  } catch (error) {
    logger.warn('SYSTEM', 'could not load active mode taxonomy; using fallback', {}, error instanceof Error ? error : new Error(String(error)));
  }
  return ['discovery', 'progress', 'blocker', 'decision'];
}

export async function resolveObsType(args: {
  content: string;
  sourceType: string;
  canonical: string[];
  classifier: TaxonomyClassifier;
}): Promise<string> {
  const canon = new Set(args.canonical);
  // Already canonical → keep verbatim, no model drift.
  if (canon.has(args.sourceType)) return args.sourceType;
  try {
    const label = await args.classifier.classify({ content: args.content, sourceType: args.sourceType });
    if (label && canon.has(label)) return label;
  } catch (error) {
    logger.warn('SYSTEM', 'taxonomy classify failed; using fallback', { sourceType: args.sourceType }, error instanceof Error ? error : new Error(String(error)));
  }
  return canon.has(FALLBACK_TYPE) ? FALLBACK_TYPE : args.canonical[0] ?? FALLBACK_TYPE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/classify-observation-type.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors. (If `ModeManager.getActiveMode()` returns a type without `observation_types`, cast as shown; confirm the import path with `grep -rn "class ModeManager" src`.)

```bash
git add src/server/runtime/import/classifyObservationType.ts tests/server/classify-observation-type.test.ts
git commit -m "feat(local): taxonomy-aware obs_type resolver (canonical-keep, model, change-fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: First-run importer — one-shot idempotent SQLite→PG import with marker

**Files:**
- Create: `src/server/runtime/import/firstRunImport.ts`
- Test: `tests/server/first-run-import.test.ts`

**Interfaces:**
- Consumes: `resolveObsType` + `loadCanonicalTypeIds` (Task 8); a `PostgresPool` (`src/storage/postgres/pool.js`); the SQLite path `~/.memsmith/memsmith.db`.
- Produces:
  ```ts
  export interface FirstRunImportDeps {
    sqliteExists: () => boolean;
    observationsEmpty: () => Promise<boolean>;
    markerExists: () => boolean;
    writeMarker: () => void;
    readSourceRows: () => Promise<Array<{ id: string; type: string; content: string }>>;
    insertRow: (row: { id: string; obsType: string; content: string }) => Promise<void>;
    classifier: import('./classifyObservationType.js').TaxonomyClassifier;
  }
  export async function runFirstRunImport(deps: FirstRunImportDeps): Promise<{ imported: number; skipped: boolean; reason?: string }>;
  ```
  Skips (no-op) when: no SQLite file, OR marker already present, OR the PG observations table is non-empty. Writes the marker only on a successful full pass.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/first-run-import.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { runFirstRunImport } from '../../src/server/runtime/import/firstRunImport.js';

function baseDeps(over: Partial<Parameters<typeof runFirstRunImport>[0]> = {}) {
  const inserted: any[] = [];
  let marker = false;
  return {
    inserted,
    deps: {
      sqliteExists: () => true,
      observationsEmpty: async () => true,
      markerExists: () => marker,
      writeMarker: () => { marker = true; },
      readSourceRows: async () => [
        { id: '1', type: 'decision', content: 'chose PG' },
        { id: '2', type: 'note', content: 'misc note' },
      ],
      insertRow: async (r: any) => { inserted.push(r); },
      classifier: { classify: async () => 'discovery' },
      ...over,
    },
    getMarker: () => marker,
  };
}

describe('runFirstRunImport', () => {
  it('imports rows and reclassifies unknown types', async () => {
    const { deps, inserted } = baseDeps();
    const res = await runFirstRunImport(deps as any);
    expect(res.imported).toBe(2);
    expect(inserted.find((r) => r.id === '1').obsType).toBe('decision');   // canonical kept
    expect(inserted.find((r) => r.id === '2').obsType).toBe('discovery');  // model-classified
  });
  it('skips when marker exists', async () => {
    const { deps } = baseDeps({ markerExists: () => true });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
  it('skips when observations table is non-empty', async () => {
    const { deps } = baseDeps({ observationsEmpty: async () => false });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
  it('skips when no sqlite file', async () => {
    const { deps } = baseDeps({ sqliteExists: () => false });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/first-run-import.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the importer orchestration**

```ts
// src/server/runtime/import/firstRunImport.ts
// SPDX-License-Identifier: Apache-2.0
import { loadCanonicalTypeIds, resolveObsType, type TaxonomyClassifier } from './classifyObservationType.js';
import { logger } from '../../../utils/logger.js';

export interface FirstRunImportDeps {
  sqliteExists: () => boolean;
  observationsEmpty: () => Promise<boolean>;
  markerExists: () => boolean;
  writeMarker: () => void;
  readSourceRows: () => Promise<Array<{ id: string; type: string; content: string }>>;
  insertRow: (row: { id: string; obsType: string; content: string }) => Promise<void>;
  classifier: TaxonomyClassifier;
}

export async function runFirstRunImport(
  deps: FirstRunImportDeps,
): Promise<{ imported: number; skipped: boolean; reason?: string }> {
  if (deps.markerExists()) return { imported: 0, skipped: true, reason: 'marker present' };
  if (!deps.sqliteExists()) return { imported: 0, skipped: true, reason: 'no sqlite db' };
  if (!(await deps.observationsEmpty())) return { imported: 0, skipped: true, reason: 'observations table not empty' };

  const canonical = loadCanonicalTypeIds();
  const rows = await deps.readSourceRows();
  let imported = 0;
  for (const row of rows) {
    const obsType = await resolveObsType({ content: row.content, sourceType: row.type, canonical, classifier: deps.classifier });
    await deps.insertRow({ id: row.id, obsType, content: row.content });
    imported += 1;
  }
  deps.writeMarker();
  logger.info('SYSTEM', 'first-run import complete', { imported });
  return { imported, skipped: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/first-run-import.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/server/runtime/import/firstRunImport.ts tests/server/first-run-import.test.ts
git commit -m "feat(local): first-run import orchestration (idempotent, marker-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Integration wiring + docs — call the importer on local boot; document `local` runtime

**Files:**
- Modify: `src/server/runtime/local-runtime.ts` (call `runFirstRunImport` after PG is ready, before service start)
- Modify: `docs/TODO.md` (mark subsystem #1 shipped; note follow-ups)
- Modify: `CLAUDE.md` (document `MEMSMITH_RUNTIME=local` + `local start|stop|status`)
- Test: `tests/server/local-runtime-import.test.ts`

**Interfaces:**
- Consumes: `startLocalRuntime` (Task 6), `runFirstRunImport` (Task 9), `EmbeddedPostgresManager` (Task 2).
- Produces: `startLocalRuntime` gains an optional `runImport?: (connectionString: string) => Promise<void>` hook that defaults to wiring the real importer (SQLite reader + PG inserter + Ollama classifier). Import failures are logged, never fatal (best-effort; the marker is only written on success so a failed import retries next boot).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/local-runtime-import.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { startLocalRuntime } from '../../src/server/runtime/local-runtime.js';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeManager(conn: string): EmbeddedPostgresManager {
  return { start: async () => ({ connectionString: conn, reused: false }), getConnectionString: () => conn, stop: async () => {}, isRunning: () => false } as unknown as EmbeddedPostgresManager;
}

describe('startLocalRuntime import hook', () => {
  it('runs the import before starting the service', async () => {
    const order: string[] = [];
    await startLocalRuntime({
      manager: fakeManager('postgres://x:y@127.0.0.1:55433/postgres'),
      runImport: async () => { order.push('import'); },
      startService: async () => { order.push('service'); },
    });
    expect(order).toEqual(['import', 'service']);
  });

  it('an import failure does not block service start', async () => {
    const order: string[] = [];
    await startLocalRuntime({
      manager: fakeManager('postgres://x:y@127.0.0.1:55433/postgres'),
      runImport: async () => { throw new Error('import boom'); },
      startService: async () => { order.push('service'); },
    });
    expect(order).toEqual(['service']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/local-runtime-import.test.ts`
Expected: FAIL — `startLocalRuntime` does not accept/await `runImport`.

- [ ] **Step 3: Add the import hook to `startLocalRuntime`**

In `src/server/runtime/local-runtime.ts`, extend the options and call sequence:
```ts
export interface StartLocalRuntimeOptions {
  manager?: EmbeddedPostgresManager;
  startService?: (connectionString: string) => Promise<void>;
  runImport?: (connectionString: string) => Promise<void>;
}
```
After setting env vars and before `await start(connectionString)`:
```ts
  const runImport = options.runImport ?? defaultRunImport;
  try {
    await runImport(connectionString);
  } catch (error) {
    logger.warn('SYSTEM', 'local first-run import failed (non-fatal; will retry next boot)', {}, error instanceof Error ? error : new Error(String(error)));
  }
```
Add a `defaultRunImport` that wires the real importer. It builds the concrete `FirstRunImportDeps`: `sqliteExists` checks `~/.memsmith/memsmith.db`; `markerExists`/`writeMarker` use `~/.memsmith/.local-import-done`; `observationsEmpty` runs `SELECT count(*) FROM observations` on a pool built from `connectionString`; `readSourceRows` reads the SQLite observations; `insertRow` inserts into PG (`ON CONFLICT DO NOTHING`); `classifier` calls the local Ollama provider. Keep `defaultRunImport` thin — delegate row read/insert to the existing `scripts/migrate-claude-mem.ts` helpers where possible (import its exported `transform`/reader if exported; otherwise inline a minimal reader). Show the concrete code:
```ts
async function defaultRunImport(connectionString: string): Promise<void> {
  const { existsSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const home = join(homedir(), '.memsmith');
  const sqlitePath = join(home, 'memsmith.db');
  const markerPath = join(home, '.local-import-done');
  const { getSharedPostgresPool } = await import('../../storage/postgres/pool.js');
  const { runFirstRunImport } = await import('./import/firstRunImport.js');
  const { buildOllamaClassifier } = await import('./import/ollamaClassifier.js'); // see Step 4
  const { readWorkerObservations } = await import('./import/sqliteReader.js');    // see Step 4
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  await runFirstRunImport({
    sqliteExists: () => existsSync(sqlitePath),
    markerExists: () => existsSync(markerPath),
    writeMarker: () => writeFileSync(markerPath, new Date(0).toISOString(), 'utf8'), // fixed literal — Date.now unavailable in some contexts; a static marker is fine
    observationsEmpty: async () => {
      const r = await pool.query('SELECT count(*)::int AS n FROM observations');
      return (r.rows[0]?.n ?? 0) === 0;
    },
    readSourceRows: () => readWorkerObservations(sqlitePath),
    insertRow: async (row) => {
      await pool.query(
        `INSERT INTO observations (id, obs_type, content, lifecycle_state, kind)
         VALUES ($1, $2, $3, $4, 'observation') ON CONFLICT (id) DO NOTHING`,
        [row.id, row.obsType, row.content, row.obsType === 'decision' ? 'active' : 'resolved'],
      );
    },
    classifier: buildOllamaClassifier(),
  });
}
```

- [ ] **Step 4: Create the two thin helpers referenced above**

Create `src/server/runtime/import/sqliteReader.ts` (reads the worker SQLite observations table into `{id,type,content}` rows — mirror how `scripts/migrate-claude-mem.ts` opens the source DB) and `src/server/runtime/import/ollamaClassifier.ts` (a `TaxonomyClassifier` that prompts the local Ollama model with the content + candidate types and parses one label). Both start with the SPDX header. Keep each focused and small. For the classifier, reuse the worker Ollama provider config resolution (`getOllamaConfig` from `src/services/worker/OllamaProvider.ts`) so it honors the user's `MEMSMITH_OLLAMA_MODEL`/`MEMSMITH_OLLAMA_URL`. If the model is unreachable, `classify` returns `null` (the resolver then falls back to `change`).

*(These helpers have no new pure logic worth a separate unit test — they are thin adapters over verified code and the Ollama HTTP call; they are exercised via the local-runtime-import test through injection, and end-to-end in the manual live test in Step 7. Do not write network-dependent unit tests for them.)*

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/local-runtime-import.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Update docs**

In `docs/TODO.md`, under "Deferred / tracked", change the "UNIFY ON ONE DB" bullet to note **subsystem #1 (embedded-PG local runtime) is SHIPPED** with a pointer to this plan, leaving #2 (private↔team unification) and #3 (team identity) open. In `CLAUDE.md` under "File Locations" or a new "Runtimes" note, document: `MEMSMITH_RUNTIME=local` runs embedded Postgres (no Docker); manage it with `worker-service local start|stop|status`; data dir `~/.memsmith/pgdata`, binaries `~/.memsmith/pg-binaries`, port `55433` (`MEMSMITH_LOCAL_PG_PORT`).

- [ ] **Step 7: Typecheck + full local test sweep + commit**

Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `bun test tests/server/embedded-postgres-manager.test.ts tests/server/embedded-postgres-lifecycle.test.ts tests/server/inline-server-queue.test.ts tests/server/inline-queue-manager.test.ts tests/server/inline-queue-config.test.ts tests/server/local-runtime.test.ts tests/server/local-runtime-import.test.ts tests/server/classify-observation-type.test.ts tests/server/first-run-import.test.ts tests/worker/parse-local-command.test.ts`
Expected: all green.

```bash
git add src/server/runtime/local-runtime.ts src/server/runtime/import/sqliteReader.ts src/server/runtime/import/ollamaClassifier.ts docs/TODO.md CLAUDE.md tests/server/local-runtime-import.test.ts
git commit -m "feat(local): wire first-run import into local boot + document local runtime

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual verification (human-gated, after Task 10)

The unit tests inject fakes so they never boot a real Postgres or hit Ollama. One end-to-end pass on this machine is required before merge and needs a human to observe:

1. `MEMSMITH_RUNTIME=local worker-service local start` → confirm embedded PG downloads once, boots on 55433, `local status` reports RUNNING, and the server HTTP comes up.
2. Confirm the first-run import ran (marker `~/.memsmith/.local-import-done` exists) and `/v1/search` returns imported rows with sensible `obs_type` values (spot-check that reclassified rows look right).
3. Confirm semantic search works (a query with no keyword overlap returns relevant rows → embeddings backfilled).
4. `worker-service local stop` → PG stops, `local status` reports stopped, restart reuses the same data dir.

This is the point to hold and call the human (voice) for testing.

## Self-Review

**Spec coverage:**
- §1 Architecture (manager → unchanged createServerService) → Tasks 1, 2, 6. ✅
- §2 Queue `inline` → Tasks 3 (config), 4 (queue), 5 (manager + wiring). ✅
- §3 Lifecycle (resident daemon, pidfile reuse, fixed port, crash recovery) → Task 2 + Task 7 (stop/status CLI). ✅
- §4 Import (taxonomy-aware, idempotent marker, embedding backfill) → Tasks 8, 9, 10. Embedding backfill: `defaultRunImport` is where `backfill-embeddings.ts` is invoked — **gap fix:** Task 10 Step 3's `defaultRunImport` must also run the embedding backfill after insert. Added note below.
- Components table (5 units) → each has a task. ✅
- Error handling (binary download fail, port occupied, stale lock, inline job fail, classify fail) → Tasks 1, 2, 4, 8. **Port-occupied-by-foreign-process fail-loud is under-specified** — see gap fix below.

**Gap fixes (applied inline to the plan):**
1. **Embedding backfill.** Task 10 §Step 3 `defaultRunImport` inserts rows but the spec requires embeddings so semantic search works immediately. Add, after `runFirstRunImport` returns with `imported > 0`: invoke the embedding backfill over the newly-inserted rows (reuse `scripts/backfill-embeddings.ts`'s `embed()` path — import `embed` from `src/server/generation/embedder.js` and `UPDATE observations SET embedding_vec = $1 WHERE id = $2 AND embedding_vec IS NULL`). This is best-effort like the rest of import. *(Implementer: fold this into `defaultRunImport`; it needs no new task since it shares the import's deps and failure semantics.)*
2. **Foreign-process port guard.** Task 2 `start()` reuses when the pidfile PID is alive, and boots fresh when stale. It does NOT yet handle "port 55433 held by a process that is NOT ours (no/!matching pidfile)". Add to Task 2 Step 4 `start()`, before `instance.start()`: if `isRunning()` is false but the port is already in use, throw a clear error: `` `MEMSMITH_LOCAL_PG_PORT ${this.port} is in use by another process. Stop it or set MEMSMITH_LOCAL_PG_PORT to a free port.` `` — never wander to a random port (Global Constraints). Use the existing `isPortInUse(port, host)` helper (same one `ServerService.ts` uses; confirm import path via `grep -rn "function isPortInUse" src`).

**Placeholder scan:** no TBD/TODO; every code step has complete code. The two thin adapters in Task 10 Step 4 (`sqliteReader`, `ollamaClassifier`) are described by responsibility with exact interfaces and reuse pointers rather than full bodies — acceptable because they are mechanical adapters over already-verified code (`migrate-claude-mem.ts` reader, `getOllamaConfig`), and their contract (`TaxonomyClassifier`, `{id,type,content}` rows) is fully pinned in Tasks 8–9.

**Type consistency:** `ServerGenerationQueueManager.start(kind, processor)` and `getQueue(kind)` (Task 5) match the calls in `ActiveServerGenerationWorkerManager` (`.start('event', dispatcher)`, `.getQueue(lane).observe(...)`). `InlineServerQueue` job shape `{id,data,attemptsMade}` matches the dispatcher's reads (`job.id`, `job.data`, `job.attemptsMade`). `resolveObsType` signature identical across Tasks 8–9. `startLocalRuntime` options grow monotonically (Task 6 → Task 10) with no renames. ✅
