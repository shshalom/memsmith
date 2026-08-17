export interface ProbeResult { connectivity: { reachable: boolean; authenticates: boolean }; fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean }; allGreen: boolean; fixable: string[]; error?: string }
// 'failed' means the request itself did not complete — a crash, a rejection, or
// a transport fault. It is deliberately distinct from 'verify_failed', which
// means the copy ran and its row counts did not match. Collapsing the two told
// users "verification failed" when verification had never run.
export interface ConvertResult {
  status: 'converted' | 'verify_failed' | 'failed';
  copiedByTable?: Record<string, number>;
  mismatches?: Array<{ table: string; local: number; remote: number }>;
  restartRequired: boolean;
  /** Present on 'failed': the server's or transport's own message, verbatim. */
  error?: string;
  /**
   * Present on success: what the project needs to start using the remote.
   *
   * The server does not apply this — the project's own session hook does, since
   * the marker and credential store live on the user's machine, not the server's.
   * Never render apiKey.
   */
  join?: { teamId: string; projectId: string; serverUrl: string; apiKey: string };
}

const NOT_GREEN: ProbeResult = { connectivity: { reachable: false, authenticates: false }, fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false }, allGreen: false, fixable: [] };

/**
 * Where this project is going.
 *
 * The HTTPS shape is the one a managed database requires: a private RDS is unreachable
 * from the machine running convert (measured — the direct probe times out even on VPN),
 * so the destination is the team server's endpoint plus the team key, and no database
 * password is involved at any point.
 *
 * The databaseUrl shape is retained for a self-hosted database the owner CAN reach.
 */
export type Destination =
  | { serverUrl: string; teamKey: string }
  | { databaseUrl: string };

export async function testConnection(dest: Destination, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    // Relative path on purpose: the request goes to the LOCAL server, which holds the
    // credential and makes any outbound call. The browser never talks to the team
    // server directly.
    const res = await fetchImpl('/v1/convert/test-connection', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dest) });
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

// Fetch the team's base key for the Invite step.
//
// The wizard used to receive this as a prop that was only non-null when the user
// had already flipped the "reveal" toggle in Identity settings — a hidden
// prerequisite that made the Invite card show "(base key not available)" on every
// normal run. Handing the user their key IS the card's job, so it fetches it.
//
// ?reveal=true is honoured for loopback requests only (the same trust boundary as
// the local dashboard), so this cannot expose a key off-machine.
export async function fetchBaseKey(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/v1/identity?reveal=true', { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json() as { keyPlaintext?: unknown };
    return typeof body?.keyPlaintext === 'string' && body.keyPlaintext.trim()
      ? body.keyPlaintext
      : null;
  } catch {
    return null;
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

export async function migrate(dest: Destination, fetchImpl: typeof fetch = fetch): Promise<ConvertResult> {
  try {
    const res = await fetchImpl('/v1/convert/migrate', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dest) });
    if (!res.ok) {
      // Keep the server's own message. A convert can fail for reasons that have
      // nothing to do with verification (a foreign-key crash, a 403, a bad URL),
      // and the user cannot act on "verification failed" when that is not what
      // happened. Fall back to the status code when the body carries no text.
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof body?.error === 'string' && body.error.trim()
        ? body.error
        : `HTTP ${res.status}`;
      return { status: 'failed', error: message, restartRequired: false };
    }
    return (await res.json()) as ConvertResult;
  } catch (e) {
    return {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
      restartRequired: false,
    };
  }
}
