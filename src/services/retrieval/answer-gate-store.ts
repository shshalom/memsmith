// src/services/retrieval/answer-gate-store.ts
// SPDX-License-Identifier: Apache-2.0
//
// Per-session state for the answer gate: did the current turn ask for
// information about past work, and has memory been searched for it yet?
// Written by UserPromptSubmit, updated by PreToolUse on a memory read, read by
// Stop — three short-lived processes, so it lives in the session directory next
// to shown.json and consulted.json. Each UserPromptSubmit overwrites it, which is
// what scopes it to one turn. Every failure degrades to "nothing pending": a
// broken file can cost a missed gate, never a wedged turn.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AnswerGateState {
  pending: boolean;
  satisfied: boolean;
  blocked: boolean;
  topic: string;
  ts: number;
}

export class AnswerGateStore {
  private readonly path: string;

  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    const safeId = (sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    this.path = join(baseDir, safeId, 'answer-gate.json');
  }

  read(): AnswerGateState | null {
    try {
      if (!existsSync(this.path)) return null;
      const v = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<AnswerGateState>;
      if (typeof v?.pending !== 'boolean') return null;
      return {
        pending: v.pending,
        satisfied: v.satisfied === true,
        blocked: v.blocked === true,
        topic: typeof v.topic === 'string' ? v.topic : '',
        ts: typeof v.ts === 'number' ? v.ts : 0,
      };
    } catch {
      return null;
    }
  }

  isUnsatisfied(): boolean {
    const s = this.read();
    return s !== null && s.pending && !s.satisfied && !s.blocked;
  }

  beginTurn(turn: { pending: boolean; topic: string }): void {
    this.write({ pending: turn.pending, satisfied: false, blocked: false, topic: turn.topic, ts: Date.now() });
  }

  markSatisfied(): void {
    const s = this.read();
    if (!s || !s.pending || s.satisfied) return;
    this.write({ ...s, satisfied: true });
  }

  markBlocked(): void {
    const s = this.read();
    if (!s) return;
    this.write({ ...s, pending: false, blocked: true });
  }

  private write(state: AnswerGateState): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      writeFileSync(this.path, JSON.stringify(state), 'utf-8');
    } catch {
      // Unwritable → the gate sees nothing pending and fails open.
    }
  }
}
