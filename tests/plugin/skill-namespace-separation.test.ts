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

  it('has the expected 17 skills, all ms-prefixed', () => {
    expect(dirs.length).toBe(17);
    for (const d of dirs) expect(d.startsWith('ms-')).toBe(true);
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
    const OLD = ['mem-search','timeline-report','how-it-works','smart-explore',
      'learn-codebase','standup','babysit','design-is','knowledge-agent',
      'make-plan','oh-my-issues','pathfinder','version-bump','weekly-digests',
      'what-the','wowerpoint'];
    for (const d of dirs) {
      const skillMd = join(SKILLS_DIR, d, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const src = readFileSync(skillMd, 'utf-8');
      for (const old of OLD) {
        const bareSlash = new RegExp(`/${old}\\b`, 'g');
        for (const match of src.matchAll(bareSlash)) {
          const idx = match.index ?? 0;
          // Skip matches that are part of a URL hostname
          // (e.g. https://wowerpoint-api.<subdomain>.workers.dev).
          // The regex matches the second `/` of `https://`, so look for `https:/`
          // or `http:/` in the 20 chars preceding the match.
          const urlCtx = src.slice(Math.max(0, idx - 20), idx);
          if (/https?:\//.test(urlCtx)) continue;
          const preceding = src.slice(Math.max(0, idx - 3), idx);
          expect(preceding.endsWith('ms-'),
            `${d}/SKILL.md has bare /${old} (must be /ms-${old})`).toBe(true);
        }
      }
    }
  });
});
