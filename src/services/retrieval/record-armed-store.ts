import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ArmedRecord { armed: boolean; promptId: string | null; ts: number }

/** Per-session "is this turn a record-intent turn" flag, written by the
 *  UserPromptSubmit hook and read by the PreToolUse interceptor (separate
 *  short-lived processes). Best-effort: never throws — a broken store
 *  degrades to "not armed". */
export class RecordArmedStore {
  private readonly path: string;
  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    // Guard against path traversal from an odd sessionId (mirrors SessionShownStore).
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    this.path = join(baseDir, safeId, 'record-armed.json');
  }
  read(): { armed: boolean; promptId: string | null } | null {
    try {
      if (!existsSync(this.path)) return null;
      const v = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<ArmedRecord>;
      if (typeof v?.armed !== 'boolean') return null;
      return { armed: v.armed, promptId: typeof v.promptId === 'string' ? v.promptId : null };
    } catch {
      return null;
    }
  }
  write(v: ArmedRecord): void {
    try {
      const dir = join(this.path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(v), 'utf-8');
    } catch {
      // best-effort; a failed write just means the interceptor treats the turn as not-armed
    }
  }
}
