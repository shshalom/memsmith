// SPDX-License-Identifier: Apache-2.0
//
// Server-side resolution of the fields the browser wizard cannot supply for
// POST /v1/convert/migrate (cwd, projectId, teamId, serverUrl, apiKey). See
// docs/superpowers/specs/2026-07-23-wizard-convert-wiring-design.md.

export interface ConvertContext {
  cwd: string;
  teamId: string;
  projectId: string;
  serverUrl: string;
  apiKey: string;
}

export type ResolveConvertContext = (databaseUrl: string) => Promise<ConvertContext | { error: string }>;

export interface ResolveConvertContextDeps {
  cwd: string;
  readScope: (cwd: string) => { teamId: string; projectId: string } | null;
  resolveKey: (teamId: string) => string | null;
  mintKey: (teamId: string, projectId: string, databaseUrl: string) => Promise<string>;
  existingServerUrl?: (cwd: string) => string | undefined;
}

export function deriveServerUrl(databaseUrl: string, existingServerUrl?: string): string {
  if (existingServerUrl && existingServerUrl.length > 0) return existingServerUrl;
  const u = new URL(databaseUrl); // throws on unparseable → surfaces as convert error
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return `http://${host}:38879`;
  // Note: a remote team server on a nonstandard port must be provided via the marker's existingServerUrl (which takes precedence above).
  return `https://${host}`;
}

export function makeResolveConvertContext(deps: ResolveConvertContextDeps): ResolveConvertContext {
  return async (databaseUrl: string) => {
    const scope = deps.readScope(deps.cwd);
    if (!scope) return { error: 'no local project identity — run inside a MemSmith project' };
    const serverUrl = deriveServerUrl(databaseUrl, deps.existingServerUrl?.(deps.cwd));
    const existing = deps.resolveKey(scope.teamId);
    const apiKey = existing ?? (await deps.mintKey(scope.teamId, scope.projectId, databaseUrl));
    return { cwd: deps.cwd, teamId: scope.teamId, projectId: scope.projectId, serverUrl, apiKey };
  };
}
