// SPDX-License-Identifier: Apache-2.0
//
// Pure helper for the "Go Team" wizard flip: writes the project marker
// (runtime=server + serverUrl) and stores the team API key in the local
// CredentialStore. Dependency-injected for testability.

export interface FlipToTeamDeps {
  writeProjectRuntime: (cwd: string, runtime: { runtime: 'server'; serverUrl: string }) => void;
  storeKeyForTeam: (teamId: string, key: string) => void;
  /** Optional — present in deps for test-spy purposes; NOT called by this function. */
  writeGlobalSettings?: (...args: unknown[]) => void;
}

export interface FlipToTeamInput {
  cwd: string;
  teamId: string;
  serverUrl: string;
  apiKey: string;
}

/**
 * Writes the project marker (runtime=server + serverUrl) and stores the team
 * API key in the local CredentialStore. Does NOT write global settings — the
 * global settings path (writeServerModeSettings) is the machine-level opt-in
 * and is NOT invoked here.
 */
export function flipToTeam(deps: FlipToTeamDeps, input: FlipToTeamInput): void {
  deps.writeProjectRuntime(input.cwd, { runtime: 'server', serverUrl: input.serverUrl });
  deps.storeKeyForTeam(input.teamId, input.apiKey);
}
