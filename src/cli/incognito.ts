// SPDX-License-Identifier: Apache-2.0
//
// Session-scoped incognito state. One file per session under
// ~/.memsmith/incognito/. Incognito is an explicit opt-in: if the flag file
// is missing or unreadable we treat the session as NOT incognito (capture
// proceeds). The on-toggle confirmation + every-N-turn heartbeat — not this
// storage — are what guard against a silently-lost ON state.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface IncognitoState { on: boolean; turns: number }

function dir(): string {
  return join(homedir(), '.memsmith', 'incognito');
}

function file(sessionId: string): string {
  return join(dir(), `${encodeURIComponent(sessionId)}.json`);
}

function read(sessionId: string): IncognitoState {
  try {
    return JSON.parse(readFileSync(file(sessionId), 'utf8')) as IncognitoState;
  } catch {
    return { on: false, turns: 0 };
  }
}

function write(sessionId: string, state: IncognitoState): void {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // fail-safe: a write failure for incognito state must never crash the hook
  }
}

export function isIncognito(sessionId: string): boolean {
  return read(sessionId).on === true;
}

export function setIncognito(sessionId: string, on: boolean): void {
  const state = read(sessionId);
  write(sessionId, { ...state, on });
}

export function bumpTurn(sessionId: string): number {
  const state = read(sessionId);
  const turns = (state.turns ?? 0) + 1;
  write(sessionId, { ...state, turns });
  return turns;
}

export function resetSession(sessionId: string): void {
  try {
    if (existsSync(file(sessionId))) rmSync(file(sessionId));
  } catch {
    // best-effort
  }
}
