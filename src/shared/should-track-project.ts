
import { relative, isAbsolute, normalize } from 'path';
import { isProjectExcluded, matchesAnyGlob } from '../utils/project-filter.js';
import { loadFromFileOnce } from './hook-settings.js';
import { OBSERVER_SESSIONS_DIR, OBSERVER_SESSIONS_PROJECT } from './paths.js';

function isWithin(child: string, parent: string): boolean {
  const normChild = normalize(child);
  const normParent = normalize(parent);
  if (normChild === normParent) return true;
  const rel = relative(normParent, normChild);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function shouldTrackProject(cwd: string): boolean {
  // 1. Internal MemSmith processes are never tracked.
  if (process.env.MEMSMITH_INTERNAL === '1') return false;
  // 2. Missing cwd → allow (hooks may fire without a cwd).
  if (!cwd) return true;
  // 3. Observer sessions dir is always excluded.
  if (isWithin(cwd, OBSERVER_SESSIONS_DIR)) {
    return false;
  }
  const settings = loadFromFileOnce();
  // 4. Exclusion list takes precedence over the allowlist.
  if (isProjectExcluded(cwd, settings.MEMSMITH_EXCLUDED_PROJECTS)) return false;
  // 5. Allowlist: when MEMSMITH_INCLUDED_PROJECTS is non-empty, only track cwds
  //    that match at least one included glob pattern (exclusions already won above).
  const includedPatterns = settings.MEMSMITH_INCLUDED_PROJECTS;
  if (includedPatterns && includedPatterns.trim()) {
    const patterns = includedPatterns
      .split(/[,;]/)
      .map(p => p.trim())
      .filter(Boolean);
    if (patterns.length > 0 && !matchesAnyGlob(cwd, patterns)) return false;
  }
  // 6. Otherwise, track.
  return true;
}

export function shouldEmitProjectRow(project: string | null | undefined): boolean {
  if (!project) return true;
  return project !== OBSERVER_SESSIONS_PROJECT;
}
