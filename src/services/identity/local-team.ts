// SPDX-License-Identifier: Apache-2.0
//
// The one team that owns every project this machine creates on its own.

import { randomUUID } from 'crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

export const LOCAL_TEAM_FILE = 'local-team.json';

interface LocalTeamFile { teamId: string; createdAt: string }

export function localTeamPath(dataDir: string = resolveDataDir()): string {
  return join(dataDir, LOCAL_TEAM_FILE);
}

export function readLocalTeamId(dataDir: string = resolveDataDir()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(localTeamPath(dataDir), 'utf-8')) as Partial<LocalTeamFile>;
    return typeof parsed.teamId === 'string' && parsed.teamId.trim() ? parsed.teamId : null;
  } catch {
    return null;
  }
}

// Written in full to a private temp file, then hard-linked into place: link
// fails if the file exists, so concurrent first sessions all adopt one winner,
// and no reader ever sees a half-written file (a plain `wx` write leaves one
// visible between create and write).
export function ensureLocalTeamId(dataDir: string = resolveDataDir()): string {
  const existing = readLocalTeamId(dataDir);
  if (existing) return existing;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const target = localTeamPath(dataDir);
  const candidate: LocalTeamFile = { teamId: randomUUID(), createdAt: new Date().toISOString() };
  const temp = `${target}.${process.pid}.${candidate.teamId}.tmp`;
  writeFileSync(temp, JSON.stringify(candidate, null, 2), 'utf-8');
  try {
    linkSync(temp, target);
    return candidate.teamId;
  } catch {
    const winner = readLocalTeamId(dataDir);
    if (winner) return winner;
    renameSync(temp, target);
    return readLocalTeamId(dataDir) ?? candidate.teamId;
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed into place */ }
  }
}
