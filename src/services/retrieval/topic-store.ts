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
import { sameTopic } from './topic-key.js';

/**
 * How long one memory consult covers the searches that follow it.
 *
 * Term overlap alone re-blocked almost every search: memory is asked in words
 * ("why does generation fail on a fresh install") while the follow-up searches
 * are code identifiers (`ollamaCanGenerate`, `next_attempt_at`) that share no
 * term with the question. Measured on a real session: dozens of blocks, nearly
 * one per grep. A consult is the agent doing the memory-first step for the
 * investigation in front of it, so it covers that investigation's searches for
 * a while; each further consult extends the window.
 */
export const CONSULT_WINDOW_MS = 10 * 60_000;

interface StoredState {
  topics: string[];
  lastConsultedAt?: number;
}

export class SessionTopicStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(
    sessionId: string,
    baseDir: string = join(homedir(), '.memsmith', 'sessions'),
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(baseDir, sessionId || 'unknown');
    this.file = join(this.dir, 'consulted.json');
  }

  private read(): StoredState {
    try {
      if (!existsSync(this.file)) return { topics: [] };
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
      // Files written before the consult window held a bare array of topics.
      if (Array.isArray(parsed)) return { topics: parsed.map(String) };
      const topics = Array.isArray(parsed?.topics) ? parsed.topics.map(String) : [];
      const at = typeof parsed?.lastConsultedAt === 'number' ? parsed.lastConsultedAt : undefined;
      return at === undefined ? { topics } : { topics, lastConsultedAt: at };
    } catch {
      // Corrupt → empty. Costs one extra consult, never a throw.
      return { topics: [] };
    }
  }

  /**
   * Has memory been consulted for this subject: recently enough to cover any
   * search, or ever for an overlapping topic (see sameTopic()).
   */
  hasConsulted(topic: string): boolean {
    if (!topic) return false;
    const state = this.read();
    if (state.lastConsultedAt !== undefined) {
      // A consult stamped in the future (clock moved back) opens nothing.
      const sinceConsult = this.now() - state.lastConsultedAt;
      if (sinceConsult >= 0 && sinceConsult <= CONSULT_WINDOW_MS) return true;
    }
    return sameTopic(topic, state.topics);
  }

  markConsulted(topic: string): void {
    // An empty topic is not a subject — storing it would unlock nothing and
    // could mask a derivation bug.
    if (!topic) return;
    try {
      const state = this.read();
      const topics = state.topics.includes(topic) ? state.topics : [...state.topics, topic];
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ topics, lastConsultedAt: this.now() }), 'utf-8');
    } catch {
      // Unwritable → the topic re-blocks next time. Degraded, never broken.
    }
  }
}
