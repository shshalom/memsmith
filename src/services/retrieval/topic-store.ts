// src/services/retrieval/topic-store.ts
// SPDX-License-Identifier: Apache-2.0
//
// Which topics has memory already been consulted for, this session?
//
// This is the state the always-memory-first gate reads. Hooks are short-lived
// separate processes and share no memory, so it persists to a session-scoped
// file — the same pattern and directory as SessionShownStore, deliberately a
// SEPARATE file because the two answer different questions:
//   shown.json     — what memory did I already INJECT (dedup, avoid noise)
//   consulted.json — what topics was memory ASKED about (unlocks the gate)
//
// Every failure path degrades to "not consulted" and never throws. A corrupt or
// unwritable file therefore costs at most one extra memory consult; it can never
// wedge the agent, per the spec's absolute fail-open constraint.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class SessionTopicStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    this.dir = join(baseDir, sessionId || 'unknown');
    this.file = join(this.dir, 'consulted.json');
  }

  private read(): Set<string> {
    try {
      if (!existsSync(this.file)) return new Set();
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
      return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
    } catch {
      // Corrupt → empty set. Costs one extra consult, never a throw.
      return new Set();
    }
  }

  hasConsulted(topic: string): boolean {
    if (!topic) return false;
    return this.read().has(topic);
  }

  markConsulted(topic: string): void {
    // An empty topic is not a subject — storing it would unlock nothing and
    // could mask a derivation bug.
    if (!topic) return;
    try {
      const set = this.read();
      if (set.has(topic)) return;
      set.add(topic);
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify([...set]), 'utf-8');
    } catch {
      // Unwritable → the topic re-blocks next time. Degraded, never broken.
    }
  }
}
