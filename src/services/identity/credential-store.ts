import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

interface CredentialFile { keys: Record<string, string>; }

/**
 * Stores the PLAINTEXT base key per team, so buildServerContext can send it.
 * The secret lives ONLY here (0600) and in the Authorization header — never in
 * a repo. This is the local implementation of the key-retrieval seam; an AWS
 * Secrets Manager backing can later implement the same resolveKeyForTeam shape.
 */
export class CredentialStore {
  private readonly path: string;

  constructor(path: string = join(homedir(), '.memsmith', 'credentials.json')) {
    this.path = path;
  }

  resolveKeyForTeam(teamId: string): string | null {
    const file = this.read();
    return file.keys[teamId] ?? null;
  }

  storeKeyForTeam(teamId: string, key: string): void {
    const file = this.read();
    file.keys[teamId] = key;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Enforce 0600 even if the file pre-existed with looser perms.
    chmodSync(this.path, 0o600);
  }

  private read(): CredentialFile {
    if (!existsSync(this.path)) return { keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CredentialFile>;
      return { keys: parsed.keys ?? {} };
    } catch {
      return { keys: {} };
    }
  }
}
