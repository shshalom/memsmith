// SPDX-License-Identifier: Apache-2.0
import { runCopy, verifyCopy, type CopyDeps } from './copy-engine.js';

export interface ConvertDeps {
  copyDeps: CopyDeps;
  flip: (databaseUrl: string) => void;
}
export interface ConvertResult {
  status: 'converted' | 'verify_failed';
  copiedByTable?: Record<string, number>;
  mismatches?: Array<{ table: string; local: number; remote: number }>;
  restartRequired: boolean;
}

export async function runConvert(
  deps: ConvertDeps,
  input: { databaseUrl: string; ownerUserId: string },
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
  deps.flip(input.databaseUrl);
  return { status: 'converted', copiedByTable, restartRequired: true };
}
