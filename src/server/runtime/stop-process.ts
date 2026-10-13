// SPDX-License-Identifier: Apache-2.0
import { isPidAlive } from '../../supervisor/process-registry.js';

export interface StopProcessDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  termWaitMs?: number;
  killWaitMs?: number;
}

const POLL_MS = 100;

export async function stopProcess(pid: number, deps: StopProcessDeps = {}): Promise<'exited' | 'survived'> {
  const kill = deps.kill ?? ((p, s) => process.kill(p, s));
  const isAlive = deps.isAlive ?? isPidAlive;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const waitForExit = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
      if (!isAlive(pid)) return true;
      await sleep(POLL_MS);
    }
    return !isAlive(pid);
  };

  try { kill(pid, 'SIGTERM'); } catch { return isAlive(pid) ? 'survived' : 'exited'; }
  if (await waitForExit(deps.termWaitMs ?? 5000)) return 'exited';
  try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  return (await waitForExit(deps.killWaitMs ?? 2000)) ? 'exited' : 'survived';
}
