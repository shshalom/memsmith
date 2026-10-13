// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, rmSync } from 'fs';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { PidInfo } from '../../supervisor/process-registry.js';

export interface ServerStateFiles { pid: string; port: string; runtime: string }

export function serverStateFiles(): ServerStateFiles {
  return { pid: paths.serverPid(), port: paths.serverPort(), runtime: paths.serverRuntime() };
}

function readJson<T>(path: string, label: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', `Failed to read ${label}`, { path }, err);
    return null;
  }
}

export function readServerPidFile(files: ServerStateFiles = serverStateFiles()): PidInfo | null {
  return readJson<PidInfo>(files.pid, 'server PID file');
}

export function readServerRuntimeState<T = Record<string, unknown>>(
  files: ServerStateFiles = serverStateFiles(),
): T | null {
  return readJson<T>(files.runtime, 'server runtime state file');
}

export function removeServerState(files: ServerStateFiles = serverStateFiles()): void {
  rmSync(files.pid, { force: true });
  rmSync(files.port, { force: true });
  rmSync(files.runtime, { force: true });
}
