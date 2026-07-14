// SPDX-License-Identifier: Apache-2.0
// Real AI-coding spend, read from ccusage (https://github.com/ryoppippi/ccusage).
// ccusage parses the local Claude Code / Codex usage logs (~/.claude, etc.) and
// reports actual token counts + USD cost. We surface it on the dashboard as the
// honest "what your coding agents cost" baseline — the real number MemSmith's
// context-compression savings are measured against.
//
// This is best-effort and self-contained: if ccusage isn't runnable (offline,
// no logs, spawn fails) the endpoint returns { available:false } and the UI
// degrades gracefully. We never block or throw.
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export interface SpendDay { date: string; costUsd: number; totalTokens: number; }
export interface SpendReport {
  available: boolean;
  scoped: boolean; // true = this project only; false = all-projects fallback
  totalCostUsd: number;
  totalTokens: number;
  days: SpendDay[];
  agentsDetected: string[];
  reason?: string;
}

// Resolve a runner for `ccusage`. Prefer bunx (present in this runtime), fall
// back to npx. The path is not user-controlled — fixed binary + fixed args.
function runnerCandidates(): Array<{ cmd: string; args: string[] }> {
  const bunx = join(homedir(), '.bun', 'bin', 'bunx');
  const base = ['ccusage@latest', 'daily', '--json'];
  return [
    { cmd: bunx, args: base },
    { cmd: 'bunx', args: base },
    { cmd: 'npx', args: ['-y', ...base] },
  ];
}

// Claude Code stores usage logs per project under
// ~/.claude/projects/<dash-encoded-cwd>/. To scope ccusage to THIS project only
// (not the user's all-projects total), we build an isolated CLAUDE_CONFIG_DIR
// whose projects/ contains a symlink to just this project's log dir, and run
// ccusage against it. If the project's log dir can't be found, we return null
// and the caller falls back to the unscoped (all-projects) run.
function projectLogDir(): string | null {
  // Claude Code encodes the project cwd by replacing '/' (and '.') with '-'.
  const cwd = process.env.MEMSMITH_PROJECT_CWD || process.cwd();
  const encoded = cwd.replace(/[/.]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', encoded);
  return existsSync(dir) ? dir : null;
}

// Build a scoped CLAUDE_CONFIG_DIR containing only this project's logs.
// Returns the config-dir path, or null if scoping isn't possible.
function buildScopedConfigDir(projectDir: string): string | null {
  try {
    const scoped = join(homedir(), '.memsmith', 'ccusage-scope');
    const projectsDir = join(scoped, 'projects');
    rmSync(scoped, { recursive: true, force: true });
    mkdirSync(projectsDir, { recursive: true });
    // Symlink the single project dir in (avoids copying large JSONL logs).
    symlinkSync(projectDir, join(projectsDir, projectDir.split('/').pop() ?? 'project'));
    return scoped;
  } catch {
    return null;
  }
}

function runOne(cmd: string, args: string[], timeoutMs: number, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('ccusage timed out')); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`ccusage exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

function parse(raw: string, scoped: boolean): SpendReport {
  const d = JSON.parse(raw) as {
    daily?: Array<{ period?: string; date?: string; agent?: string; totalCost?: number; totalTokens?: number }>;
    totals?: { totalCost?: number; totalTokens?: number };
  };
  const totals = d.totals ?? {};
  // Roll up per-date across agents (ccusage emits one row per agent per date).
  const byDate = new Map<string, SpendDay>();
  const agents = new Set<string>();
  for (const row of d.daily ?? []) {
    const date = String(row.period ?? row.date ?? '').slice(0, 10);
    if (!date) continue;
    if (row.agent && row.agent !== 'all') agents.add(String(row.agent));
    const cur = byDate.get(date) ?? { date, costUsd: 0, totalTokens: 0 };
    cur.costUsd += Number(row.totalCost ?? 0);
    cur.totalTokens += Number(row.totalTokens ?? 0);
    byDate.set(date, cur);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  return {
    available: true,
    scoped,
    totalCostUsd: Number(totals.totalCost ?? days.reduce((s, x) => s + x.costUsd, 0)),
    totalTokens: Number(totals.totalTokens ?? days.reduce((s, x) => s + x.totalTokens, 0)),
    days,
    agentsDetected: [...agents],
  };
}

let cache: { at: number; report: SpendReport } | null = null;
const CACHE_MS = 5 * 60 * 1000;

// `nowMs` is injected (Date.now() is banned in some contexts and keeps this
// testable). Callers pass Date.now().
export async function getSpendReport(nowMs: number): Promise<SpendReport> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.report;

  // Prefer a project-scoped run: point CLAUDE_CONFIG_DIR at an isolated view of
  // just this project's Claude Code logs, so the cost is THIS project's, not
  // the user's all-projects total. Fall back to unscoped if scoping fails.
  const projectDir = projectLogDir();
  const scopedCfg = projectDir ? buildScopedConfigDir(projectDir) : null;
  const attempts: Array<{ env?: Record<string, string>; scoped: boolean }> = scopedCfg
    ? [{ env: { CLAUDE_CONFIG_DIR: scopedCfg }, scoped: true }, { scoped: false }]
    : [{ scoped: false }];

  for (const attempt of attempts) {
    for (const { cmd, args } of runnerCandidates()) {
      try {
        const raw = await runOne(cmd, args, 20000, attempt.env);
        const report = parse(raw, attempt.scoped);
        // A scoped run that produced zero data isn't useful — fall through to
        // the unscoped attempt rather than showing an empty scoped report.
        if (attempt.scoped && report.days.length === 0) break;
        cache = { at: nowMs, report };
        return report;
      } catch (e) {
        logger.debug?.('SYSTEM', 'ccusage runner failed, trying next', { cmd, scoped: attempt.scoped, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  const report: SpendReport = { available: false, scoped: false, totalCostUsd: 0, totalTokens: 0, days: [], agentsDetected: [], reason: 'ccusage not runnable (no logs, offline, or not installed)' };
  cache = { at: nowMs, report };
  return report;
}
