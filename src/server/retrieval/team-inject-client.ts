// SPDX-License-Identifier: Apache-2.0
// Bridge client: a WORKER-mode SessionStart hook uses this to fetch cross-team
// memory from the SERVER-mode Postgres API (POST /v1/search) with a scoped
// read key. Kept deliberately small and total — it NEVER throws (a memory
// fetch must never break session startup) and no-ops unless fully configured.
//
// Design note: the SessionStart context handler runs in worker mode (SQLite),
// but team memory lives in the server-mode Postgres store (Sprints 1-2). Rather
// than give the worker a Postgres connection (larger blast radius), the hook
// calls the server's already-authed /v1/search endpoint with a scoped
// memories:read key. This keeps worker mode untouched and the trust boundary
// explicit. Opt-in: requires the flag CLAUDE_MEM_TEAM_INJECT plus a configured
// server URL and key — any missing piece disables the bridge.

export interface TeamMemoryRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface FetchTeamMemoryInput {
  serverUrl: string;
  apiKey: string;
  projectId: string;
  teamId: string;
  query: string;
  limit?: number;
}

/**
 * Fetch cross-team observations from the server-mode /v1/search endpoint.
 * Returns [] (never throws) on missing config, non-ok response, or any error —
 * a failed team-memory fetch must degrade silently, never break the session.
 * `fetchImpl` is injectable for testing; defaults to global fetch.
 */
export async function fetchTeamMemory(
  input: FetchTeamMemoryInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TeamMemoryRow[]> {
  const serverUrl = (input.serverUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey = (input.apiKey ?? '').trim();
  if (!serverUrl || !apiKey || !input.query.trim()) return [];

  try {
    const res = await fetchImpl(`${serverUrl}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        projectId: input.projectId,
        query: input.query,
        limit: input.limit ?? 5,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { observations?: TeamMemoryRow[] };
    return Array.isArray(data.observations) ? data.observations : [];
  } catch {
    return [];
  }
}
