export interface ProbeResult { connectivity: { reachable: boolean; authenticates: boolean }; fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean }; allGreen: boolean; fixable: string[]; error?: string }
export interface ConvertResult { status: 'converted' | 'verify_failed'; copiedByTable?: Record<string, number>; mismatches?: Array<{ table: string; local: number; remote: number }>; restartRequired: boolean }

const NOT_GREEN: ProbeResult = { connectivity: { reachable: false, authenticates: false }, fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false }, allGreen: false, fixable: [] };

export async function testConnection(databaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl('/v1/convert/test-connection', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl }) });
    if (!res.ok) return { ...NOT_GREEN, error: `HTTP ${res.status}` };
    return (await res.json()) as ProbeResult;
  } catch (e) {
    return { ...NOT_GREEN, error: e instanceof Error ? e.message : String(e) };
  }
}

// Apply a remediation the probe marked fixable (currently only 'pgvector').
// The server allowlists the fix name — this never sends free-form SQL.
export async function applyFix(
  databaseUrl: string,
  fix: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl('/v1/convert/apply-fix', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ databaseUrl, fix }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (body as any)?.error ?? `HTTP ${res.status}` };
    return body as { ok: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Ask the server whether a real owner identity already exists for this install.
// The wizard uses this to decide whether the Sign-In card is needed at all —
// the owner of a single-user local install has nobody else to be.
//
// Fail-safe: any failure reports false, which KEEPS the sign-in step. Showing a
// shorter path and then discovering there is no owner is worse than asking.
export async function fetchOwnerEstablished(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/v1/identity', { credentials: 'include' });
    if (!res.ok) return false;
    const body = await res.json() as { ownerEstablished?: unknown };
    return body?.ownerEstablished === true;
  } catch {
    return false;
  }
}

export async function migrate(databaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConvertResult> {
  try {
    const res = await fetchImpl('/v1/convert/migrate', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl }) });
    if (!res.ok) return { status: 'verify_failed', restartRequired: false };
    return (await res.json()) as ConvertResult;
  } catch {
    return { status: 'verify_failed', restartRequired: false };
  }
}
