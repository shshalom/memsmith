import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, openSync, closeSync, unlinkSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

interface CredentialFile { keys: Record<string, string>; }

/**
 * How long to wait for another process to release the write lock.
 *
 * Hook processes are short-lived and the critical section is a few
 * milliseconds of synchronous fs work, so contention clears almost instantly.
 * The budget only has to cover a pathological scheduler stall.
 */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
/** A lock older than this is assumed orphaned by a process that died mid-write. */
const LOCK_STALE_MS = 10_000;

/**
 * Stores the PLAINTEXT base key per team, so buildServerContext can send it.
 * The secret lives ONLY here (0600) and in the Authorization header — never in
 * a repo. This is the local implementation of the key-retrieval seam; an AWS
 * Secrets Manager backing can later implement the same resolveKeyForTeam shape.
 *
 * CONCURRENCY: every project on this machine shares this one file, and hooks are
 * separate short-lived processes with nothing serialising them. storeKeyForTeam
 * used to be a bare read-modify-write, which loses updates whenever two read
 * windows overlap — measured at 8 concurrent hook processes storing 8 teams:
 * only 5 keys survived, reproducible on every trial.
 *
 * A lost key is not cosmetic. ensureBaseKey exists precisely to guarantee that a
 * marker always has a resolvable key, because a keyless marker makes every hook
 * fall back to `missing_api_key` and silently drop observations. Dropping the
 * key here reintroduces that "dark capture" hole one layer down, with no error
 * surfaced — capture simply stops for that project.
 *
 * So writes take a cross-process lock and land atomically via rename. Reads stay
 * lock-free: rename is atomic, so a reader sees either the old file or the new
 * one, never a truncated one.
 */
export class CredentialStore {
  private readonly path: string;

  /**
   * Defaults to `<data dir>/credentials.json`, NOT `~/.memsmith/credentials.json`.
   *
   * ISOLATION. Every other piece of state honours MEMSMITH_DATA_DIR; this file
   * hardcoded homedir(), so it was the one thing an isolated run could not move.
   * The team-mode rig sets MEMSMITH_DATA_DIR (scripts/rig/team-up.sh) and its
   * preflight guard refuses the dogfood data dir and ports — yet every
   * production caller constructs `new CredentialStore()` with no argument, so a
   * rig or test that minted a key still wrote the DEVELOPER'S REAL credentials
   * file. Verified before this change:
   *   MEMSMITH_DATA_DIR=/tmp/x -> /Users/<me>/.memsmith/credentials.json
   * The dogfood project is a live workspace whose keys live in that file, and a
   * lost or clobbered key silently stops capture (see the "dark capture" note
   * above) — so this was a real path to breaking a working install from a test.
   *
   * resolveDataDir() is called per-construction rather than read from the DATA_DIR
   * constant, so a process that sets MEMSMITH_DATA_DIR before constructing the
   * store is honoured regardless of module import order.
   */
  constructor(path: string = join(resolveDataDir(), 'credentials.json')) {
    this.path = path;
  }

  resolveKeyForTeam(teamId: string): string | null {
    const file = this.read();
    return file.keys[teamId] ?? null;
  }

  /** Team ids this machine currently holds a key for. Read-only; used by the
   * project switcher (GET /v1/projects) to mirror the exact cookie rule — a
   * project only ever appears if this machine could actually open it. */
  listTeamIdsWithKeys(): string[] {
    return Object.keys(this.read().keys);
  }

  /**
   * Persist one team's key without disturbing any other team's.
   *
   * The read MUST happen inside the lock. Reading beforehand is what lost
   * updates: another process could commit between our read and our write, and
   * we would flush a snapshot that predates their key.
   */
  storeKeyForTeam(teamId: string, key: string): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    this.withLock(() => {
      const file = this.read();
      file.keys[teamId] = key;
      this.writeAtomic(file);
    });
  }

  /**
   * Store `key` only if this team has no key yet; otherwise return the existing
   * one. The check and the write happen under the same lock.
   *
   * This is what makes concurrent minting safe. ensureBaseKey reads the cache,
   * sees nothing, mints, and writes — and N racing starts each pass that check
   * before any of them writes, so N distinct keys get minted and inserted into
   * api_keys while the cache keeps only the last. Measured: 5 concurrent starts
   * produced 5 keys and 5 api_keys rows for one team.
   *
   * The four orphans are not merely wasted rows. Each is a VALID credential
   * whose plaintext no longer exists anywhere — so it cannot be used and cannot
   * be identified to revoke. Deciding the winner here, atomically, means only
   * one key is ever adopted.
   */
  storeKeyIfAbsent(teamId: string, key: string): string {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    return this.withLock(() => {
      const file = this.read();
      const existing = file.keys[teamId];
      if (existing) return existing;
      file.keys[teamId] = key;
      this.writeAtomic(file);
      return key;
    });
  }

  /**
   * Write via a temp file + rename so a concurrent reader never observes a
   * partially written file. A direct writeFileSync truncates first, so a reader
   * landing in that window parses garbage — and read() swallows parse errors and
   * returns {}, which reports "this machine holds no keys at all" and makes
   * every project look keyless at once.
   */
  private writeAtomic(file: CredentialFile): void {
    // Same directory as the target: rename is only atomic within a filesystem.
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      // Atomic replace. The destination keeps the source's 0600 mode.
      renameSync(tmp, this.path);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * Serialise writers across processes using an exclusive-create lockfile.
   *
   * `wx` fails if the path exists, which is the atomic test-and-set POSIX gives
   * us without extra dependencies. A stale lock (owner died mid-write) is broken
   * after LOCK_STALE_MS so one crash cannot wedge credential storage forever.
   *
   * On timeout the write proceeds anyway. Losing an update is bad; refusing to
   * store the key at all is worse — that guarantees the dark capture this whole
   * class exists to prevent, instead of merely risking it.
   */
  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let held = false;

    while (Date.now() < deadline) {
      try {
        closeSync(openSync(lockPath, 'wx'));
        held = true;
        break;
      } catch {
        // Someone holds it. Break it if its owner is clearly gone.
        try {
          const age = Date.now() - lockMtimeMs(lockPath);
          if (age > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock vanished between the check and the stat — retry immediately.
          continue;
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      if (held) {
        try { unlinkSync(lockPath); } catch { /* already gone */ }
      }
    }
  }

  private read(): CredentialFile {
    if (!existsSync(this.path)) return { keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CredentialFile>;
      return { keys: parsed.keys ?? {} };
    } catch {
      // A corrupt file must not be silently overwritten: it may still hold
      // recoverable plaintext keys, and those are unrecoverable once gone.
      // Preserve it beside the original before the caller writes on top.
      try {
        const salvage = `${this.path}.corrupt`;
        if (!existsSync(salvage)) renameSync(this.path, salvage);
      } catch { /* best effort — never block key storage */ }
      return { keys: {} };
    }
  }
}

/** mtime in epoch ms, for stale-lock detection. */
function lockMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

/**
 * Block this thread briefly.
 *
 * The critical section is synchronous (callers are sync), so an async sleep is
 * not an option. Atomics.wait on a throwaway buffer is the portable way to pause
 * without a busy spin burning CPU while another process finishes its write.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
