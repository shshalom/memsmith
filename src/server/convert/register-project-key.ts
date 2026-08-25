// SPDX-License-Identifier: Apache-2.0
//
// Teach the remote about the project's EXISTING key — the HTTPS counterpart to
// ensureBaseKey's hash insert.
//
// A project's key is minted when the project is created and never changes. Converting to
// team changes WHERE the project points, not WHO it is. The direct-Postgres path keeps
// that invariant by calling ensureBaseKey, which re-inserts the project's own key hash
// into the remote api_keys table over its pool; its comment is blunt about the
// alternative — "minting a second key would be the actual bug — it orphans a credential
// whose plaintext is gone, which can be neither used nor revoked."
//
// The HTTPS path has no pool by design, and /v1/join/register only upserts the PROJECT
// row — it never registers a key. Without this step the convert had to hand the
// destination team key back as the project's identity, which overwrote the project's own
// key and left the local dashboard unable to authenticate: the cached plaintext was
// minted on the remote, so no local api_keys row could ever match its hash.
//
// ONLY THE HASH CROSSES THE WIRE. The remote stores hashes; sending the plaintext would
// put a live credential in request bodies and remote logs for no benefit.

export interface RegisterProjectKeyInput {
  /** The team server's HTTPS endpoint. */
  serverUrl: string;
  /** The DESTINATION team key — authorization for this call, not the project's identity. */
  teamKey: string;
  projectId: string;
  /** SHA-256 of the project's own key, the same hash api_keys stores. */
  projectKeyHash: string;
  /**
   * Destination team, used ONLY to recover from "requires role owner".
   *
   * Optional so existing callers keep their exact behaviour: without it the
   * bootstrap retry below is skipped and a 403 is reported as before.
   */
  teamId?: string;
  fetchImpl?: typeof fetch;
}

export interface RegisterProjectKeyResult {
  ok: boolean;
  reason?: string;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Register the project's existing key hash on the remote.
 *
 * Returns a result rather than throwing: by the time this runs the copy has already
 * succeeded and the data is on the remote, so a bookkeeping failure must not be reported
 * as a failed convert. The caller logs it and leaves the project local, which is
 * recoverable — a retry is idempotent.
 */
export async function registerProjectKeyHash(
  input: RegisterProjectKeyInput,
): Promise<RegisterProjectKeyResult> {
  const base = stripTrailingSlash(input.serverUrl);
  const fetchImpl = input.fetchImpl ?? fetch;

  const post = async (): Promise<Response> =>
    fetchImpl(`${base}/v1/convert/register-key`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.teamKey}`,
      },
      body: JSON.stringify({ projectId: input.projectId, keyHash: input.projectKeyHash }),
    });

  let response: Response;
  try {
    response = await post();

    // RECOVER FROM "requires role owner", ONCE.
    //
    // register-key is owner-gated, and a user's team key has no team_members row
    // on the remote — so its role is null and this 403s. Measured live against
    // AWS; it is what blocked a real convert. The bootstrap route exists to fix
    // exactly this, but a user cannot be expected to know it exists, let alone
    // curl it between two halves of a wizard step. If convert does not call it,
    // the feature is reachable only by someone reading the source.
    //
    // ONE attempt, and only for this failure. A 403 that survives bootstrap is
    // genuine — the team has an owner and it is not this caller — so retrying
    // would turn a clear refusal into a hang. A 500 is not an authorization
    // problem and must not trigger it either.
    if (response.status === 403 && input.teamId !== undefined) {
      const detail = await response.clone().json().catch(() => null) as { message?: string } | null;
      if (/requires role owner/i.test(detail?.message ?? '')) {
        // Self-scoped when no id is given. The converting client holds the
        // destination team's KEY but not its ID — the only id it has is its own
        // LOCAL team, and sending that would fail the remote's
        // keyTeamId !== requestedTeamId check every time. So the remote infers
        // the team from the key it presented.
        const teamId = input.teamId.trim();
        const bootUrl = teamId
          ? `${base}/v1/teams/${encodeURIComponent(teamId)}/bootstrap-owner`
          : `${base}/v1/teams/bootstrap-owner`;
        const boot = await fetchImpl(
          bootUrl,
          { method: 'POST', headers: { authorization: `Bearer ${input.teamKey}` } },
        );
        // A 404 means the deployment never enabled bootstrap. Report the
        // ORIGINAL 403 rather than the 404: "not found" on a route the user has
        // never heard of would send them chasing the wrong thing.
        if (boot.ok) response = await post();
      }
    }
  } catch {
    // Deliberately does not include the thrown message: a fetch error can echo the
    // request, and the request carries the destination key in its Authorization header.
    return { ok: false, reason: `cannot reach that server at ${base}` };
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    return {
      ok: false,
      // Prefer the server's message over its error label: "requires role owner"
      // tells the user what happened; "Forbidden" does not.
      reason: detail?.message ?? detail?.error ?? `register-key failed with HTTP ${response.status}`,
    };
  }
  return { ok: true };
}
