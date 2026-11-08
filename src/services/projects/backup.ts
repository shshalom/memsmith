// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';
import { chmodSync, closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

export function backupsDir(): string {
  return join(resolveDataDir(), 'backups');
}

export function embeddedPgBinDir(binariesDir: string = join(homedir(), '.memsmith', 'pg-binaries')): string {
  return join(binariesDir, 'bin');
}

export function embeddedPgDumpPath(binariesDir?: string): string {
  return join(embeddedPgBinDir(binariesDir), process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
}

export function backupFileName(kind: 'merge' | 'prune', label: string, now: Date = new Date(), extension = 'sql'): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${kind}-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}.${extension}`;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Writes `content` to `file`, readable only by you, and flushes it to disk before returning. */
export function writeBackupFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

export type DumpDatabase = (connectionString: string, file: string) => Promise<void>;

/**
 * Writes a plain-SQL pg_dump of one database to `file`, readable only by you,
 * and flushes it to disk. Throws, and leaves no file behind, when pg_dump,
 * the pipe, or the write fails, or when pg_dump writes nothing.
 */
export function pgDumpWith(pgDump: string = embeddedPgDumpPath()): DumpDatabase {
  return async (connectionString, file) => {
    if (!existsSync(pgDump)) throw new Error(`pg_dump not found at ${pgDump}`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const lib = join(pgDump, '..', '..', 'lib');
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(file, { mode: 0o600, flags: 'wx' });
        const stderr: string[] = [];
        let exitCode: number | null = null;
        let finished = false;
        let failed = false;
        const fail = (error: unknown) => {
          if (failed) return;
          failed = true;
          child.kill();
          out.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const settle = () => {
          if (failed || exitCode === null || !finished) return;
          if (exitCode !== 0) return fail(new Error(`pg_dump exited with code ${exitCode}: ${stderr.join('').trim() || 'no output'}`));
          resolve();
        };
        const child = spawn(pgDump, ['--no-owner', '--no-privileges', `--dbname=${connectionString}`], {
          env: { ...process.env, DYLD_LIBRARY_PATH: lib, LD_LIBRARY_PATH: lib },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        out.on('error', fail);
        out.on('finish', () => { finished = true; settle(); });
        child.on('error', fail);
        child.stdout.on('error', fail);
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
        child.on('close', (code) => { exitCode = code ?? 1; settle(); });
        child.stdout.pipe(out);
      });
      if (statSync(file).size === 0) throw new Error('pg_dump wrote nothing');
      chmodSync(file, 0o600);
      fsyncPath(file);
    } catch (error) {
      rmSync(file, { force: true });
      throw error;
    }
  };
}
