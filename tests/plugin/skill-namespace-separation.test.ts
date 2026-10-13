import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

// Every MemSmith skill must be ms-prefixed so it never collides with a
// claude-mem skill of the same base name when both plugins load. This guards
// both the directory name AND the `name:` frontmatter, which must agree.
const SKILLS_DIR = join(import.meta.dir, '..', '..', 'plugin', 'skills');

describe('skill namespace separation (ms- prefix)', () => {
  const dirs = readdirSync(SKILLS_DIR).filter(d =>
    statSync(join(SKILLS_DIR, d)).isDirectory());

  it('ships exactly the memory skills, all ms-prefixed', () => {
    expect([...dirs].sort()).toEqual([
      'ms-dashboard',
      'ms-how-it-works',
      'ms-mem-search',
      'ms-smart-explore',
    ]);
  });

  it('each SKILL.md name: frontmatter matches its ms- directory name', () => {
    for (const d of dirs) {
      const skillMd = join(SKILLS_DIR, d, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const src = readFileSync(skillMd, 'utf-8');
      const m = src.match(/^name:\s*(\S+)\s*$/m);
      expect(m, `${d}/SKILL.md missing name:`).toBeTruthy();
      expect(m![1]).toBe(d);
    }
  });

  it('no SKILL.md references a bare (un-prefixed) old skill name via slash-command', () => {
    // After renaming, any "/mem-search"-style reference to another skill must be
    // "/ms-mem-search". Catch stragglers: a "/<oldname>" not preceded by "ms-".
    const OLD = ['mem-search','how-it-works','smart-explore','dashboard'];
    for (const d of dirs) {
      const skillMd = join(SKILLS_DIR, d, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const src = readFileSync(skillMd, 'utf-8');
      for (const old of OLD) {
        const bareSlash = new RegExp(`/${old}\\b`, 'g');
        for (const match of src.matchAll(bareSlash)) {
          const idx = match.index ?? 0;
          // The regex matches the second `/` of `https://` in a URL hostname.
          const urlCtx = src.slice(Math.max(0, idx - 20), idx);
          if (/https?:\//.test(urlCtx)) continue;
          const preceding = src.slice(Math.max(0, idx - 3), idx);
          expect(preceding.endsWith('ms-'),
            `${d}/SKILL.md has bare /${old} (must be /ms-${old})`).toBe(true);
        }
      }
    }
  });

  it('every /ms- reference in a skill names a skill the plugin ships', () => {
    const shipped = new Set(dirs);
    for (const d of dirs) {
      for (const file of readdirSync(join(SKILLS_DIR, d)).filter(f => f.endsWith('.md'))) {
        const src = readFileSync(join(SKILLS_DIR, d, file), 'utf-8');
        for (const match of src.matchAll(/\/(ms-[a-z0-9-]+)/g)) {
          expect(shipped.has(match[1]), `${d}/${file} references missing /${match[1]}`).toBe(true);
        }
      }
    }
  });

  it('every tool call in a skill code block names a tool the MCP server exposes', () => {
    const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts'), 'utf-8');
    const exposed = new Set([...server.matchAll(/^    name: '([a-z_]+)',$/gm)].map(m => m[1]));
    expect(exposed.has('observation_search')).toBe(true);
    for (const d of dirs) {
      const src = readFileSync(join(SKILLS_DIR, d, 'SKILL.md'), 'utf-8');
      const blocks = [...src.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]);
      for (const block of blocks) {
        for (const call of block.matchAll(/^(?:\d+\.\s+)?([a-z][a-z_]+)\(/gm)) {
          expect(exposed.has(call[1]), `${d}/SKILL.md calls unknown tool ${call[1]}`).toBe(true);
        }
      }
    }
  });
});
