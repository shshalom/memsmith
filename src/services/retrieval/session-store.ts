import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Per-session record of which observation ids the broker has already injected,
 *  so repeated hooks in one session don't re-inject the same memory. Persisted
 *  to a file because hooks are short-lived separate processes. Best-effort:
 *  never throws — a broken store degrades to "nothing shown yet". */
export class SessionShownStore {
  private readonly path: string;
  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    // Guard against path traversal from an odd sessionId.
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    this.path = join(baseDir, safeId, 'shown.json');
  }
  readShown(): Set<string> {
    try {
      if (!existsSync(this.path)) return new Set();
      const arr = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
      return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
    } catch {
      return new Set();
    }
  }
  markShown(ids: string[]): void {
    try {
      const merged = this.readShown();
      for (const id of ids) merged.add(id);
      const dir = join(this.path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify([...merged]), 'utf-8');
    } catch {
      // best-effort; a failed write just means possible re-injection next turn
    }
  }
}
