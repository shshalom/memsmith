// SPDX-License-Identifier: Apache-2.0
import { runCopy, verifyCopy, type CopyDeps } from './copy-engine.js';

export interface ConvertDeps {
  copyDeps: CopyDeps;
  flip: (input: ConvertFlipInput) => void;
}

/** Fields the flip receives for writing the project marker + team key. */
export interface ConvertFlipInput {
  databaseUrl: string;
  cwd: string;
  teamId: string;
  serverUrl: string;
  apiKey: string;
}

export interface ConvertResult {
  status: 'converted' | 'verify_failed';
  copiedByTable?: Record<string, number>;
  mismatches?: Array<{ table: string; local: number; remote: number }>;
  restartRequired: boolean;
}

export async function runConvert(
  deps: ConvertDeps,
  input: { databaseUrl: string; ownerUserId: string; cwd: string; teamId: string; serverUrl: string; apiKey: string },
  onProgress?: (p: { phase: 'copying' | 'verifying' | 'switching'; table?: string; copied?: number }) => void,
): Promise<ConvertResult> {
  onProgress?.({ phase: 'copying' });
  const { copiedByTable } = await runCopy(
    deps.copyDeps,
    input.ownerUserId,
    (p) => onProgress?.({ phase: 'copying', table: p.table, copied: p.copied }),
  );

  onProgress?.({ phase: 'verifying' });
  const verify = await verifyCopy(deps.copyDeps);
  if (!verify.ok) {
    return { status: 'verify_failed', mismatches: verify.mismatches, restartRequired: false };
  }

  onProgress?.({ phase: 'switching' });
  deps.flip({ databaseUrl: input.databaseUrl, cwd: input.cwd, teamId: input.teamId, serverUrl: input.serverUrl, apiKey: input.apiKey });
  return { status: 'converted', copiedByTable, restartRequired: true };
}
