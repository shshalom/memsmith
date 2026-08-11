// src/services/retrieval/warm-path-store.ts
// SPDX-License-Identifier: Apache-2.0
//
// Which files has the agent already read this session?
//
// Amendment 1 gates `Read` to COLD reads only: opening a spec you have not seen
// is discovery, re-reading a file already in context is not. Hooks are separate
// short-lived processes, so "already read" has to persist — third small store in
// the same session directory as shown.json and consulted.json.
//
// Same never-throw contract as SessionTopicStore: any failure degrades to "not
// warm", which costs at most one unnecessary memory consult.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class WarmPathStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    this.dir = join(baseDir, sessionId || 'unknown');
    this.file = join(this.dir, 'warm.json');
  }

  read(): ReadonlySet<string> {
    try {
      if (!existsSync(this.file)) return new Set();
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
      return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
    } catch {
      return new Set();
    }
  }

  has(path: string): boolean {
    if (!path) return false;
    return this.read().has(path);
  }

  mark(path: string): void {
    if (!path) return;
    try {
      const set = new Set(this.read());
      if (set.has(path)) return;
      set.add(path);
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify([...set]), 'utf-8');
    } catch {
      // Unwritable → the read stays "cold" and may be gated again. Degraded, never broken.
    }
  }
}
