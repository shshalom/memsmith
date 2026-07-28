// SPDX-License-Identifier: Apache-2.0
import { runCopy, verifyCopy, type CopyDeps } from './copy-engine.js';

export interface ConvertDeps {
  copyDeps: CopyDeps;
}

export interface ConvertResult {
  status: 'converted' | 'verify_failed';
  copiedByTable?: Record<string, number>;
  mismatches?: Array<{ table: string; local: number; remote: number }>;
  restartRequired: boolean;
  /**
   * On success: what the project needs in order to start using the remote.
   *
   * The server deliberately does NOT apply this. Writing the project's
   * `.memsmith/project.json` and its entry in `~/.memsmith/credentials.json` is
   * the job of the process that runs IN that project (the CLI/session hook),
   * which already owns both files.
   *
   * The server used to do it via flipToTeam(cwd, ...), which only worked because
   * local and server happen to be the same machine — on a real remote team
   * server that cwd is a directory on someone else's box. Worse, the cwd it used
   * was the SERVER's, so it would have flipped the wrong project's marker: the
   * same class of bug as the copy-scope leak, one step later and less
   * recoverable.
   *
   * Nothing is lost by handing this back instead of applying it: the copy is
   * additive (no local deletes) and the remote insert is ON CONFLICT DO NOTHING,
   * so a copy that succeeds without a flip leaves local intact, the remote
   * populated, and a retry safe.
   */
  join?: ConvertJoinInfo;
}

/** Everything the project's own process needs to complete the switch. */
export interface ConvertJoinInfo {
  teamId: string;
  projectId: string;
  serverUrl: string;
  apiKey: string;
}

export async function runConvert(
  deps: ConvertDeps,
  input: {
    databaseUrl: string;
    ownerUserId: string;
    teamId: string;
    projectId: string;
    serverUrl: string;
    apiKey: string;
  },
  onProgress?: (p: { phase: 'copying' | 'verifying'; table?: string; copied?: number }) => void,
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

  // restartRequired is false: selectRuntime() re-reads the project marker on
  // every call and buildServerContext() takes the marker's serverUrl at highest
  // precedence, both verified live — so a flipped project is served from the
  // remote on its very next hook invocation with no restart. The previous `true`
  // described a GLOBAL runtime switch (settings.json, which IS cached) and was
  // carried over to the per-project convert where it does not apply.
  return {
    status: 'converted',
    copiedByTable,
    restartRequired: false,
    join: {
      teamId: input.teamId,
      projectId: input.projectId,
      serverUrl: input.serverUrl,
      apiKey: input.apiKey,
    },
  };
}
