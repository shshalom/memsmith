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
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${base}/v1/convert/register-key`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.teamKey}`,
      },
      body: JSON.stringify({ projectId: input.projectId, keyHash: input.projectKeyHash }),
    });
  } catch {
    // Deliberately does not include the thrown message: a fetch error can echo the
    // request, and the request carries the destination key in its Authorization header.
    return { ok: false, reason: `cannot reach that server at ${base}` };
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    return { ok: false, reason: detail?.error ?? `register-key failed with HTTP ${response.status}` };
  }
  return { ok: true };
}
