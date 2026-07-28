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

export async function migrate(databaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConvertResult> {
  try {
    const res = await fetchImpl('/v1/convert/migrate', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl }) });
    if (!res.ok) return { status: 'verify_failed', restartRequired: false };
    return (await res.json()) as ConvertResult;
  } catch {
    return { status: 'verify_failed', restartRequired: false };
  }
}
