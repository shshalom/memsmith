// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

export function backupsDir(): string {
  return join(resolveDataDir(), 'backups');
}

export function embeddedPgDumpPath(binariesDir: string = join(homedir(), '.memsmith', 'pg-binaries')): string {
  return join(binariesDir, 'bin', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
}

export function backupFileName(kind: 'merge' | 'prune', label: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${kind}-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}.sql`;
}

export type DumpDatabase = (connectionString: string, file: string) => Promise<void>;

/**
 * Writes a plain-SQL pg_dump of one database to `file`, readable only by you.
 * Throws, and leaves no partial file, when pg_dump fails or writes nothing.
 */
export function pgDumpWith(pgDump: string = embeddedPgDumpPath()): DumpDatabase {
  return async (connectionString, file) => {
    if (!existsSync(pgDump)) throw new Error(`pg_dump not found at ${pgDump}`);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const lib = join(pgDump, '..', '..', 'lib');
    const out = createWriteStream(file, { mode: 0o600 });
    const stderr: string[] = [];
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(pgDump, ['--no-owner', '--no-privileges', `--dbname=${connectionString}`], {
        env: { ...process.env, DYLD_LIBRARY_PATH: lib, LD_LIBRARY_PATH: lib },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(out);
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? 1));
    }).catch((error: unknown) => {
      out.destroy();
      rmSync(file, { force: true });
      throw error;
    });
    await new Promise<void>((resolve) => (out.closed ? resolve() : out.on('close', () => resolve())));
    if (code !== 0 || statSync(file).size === 0) {
      rmSync(file, { force: true });
      throw new Error(`pg_dump exited with code ${code}: ${stderr.join('').trim() || 'no output'}`);
    }
    chmodSync(file, 0o600);
  };
}
