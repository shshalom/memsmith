// SPDX-License-Identifier: Apache-2.0
//
// Show what SessionStart will actually inject.
//
// The old preview fetched `/api/projects` and `/api/context/preview` from the
// legacy worker. Both died with it, and useContextPreview was left a deliberate
// no-op returning the string "Context preview is not available on the local
// runtime." That message is itself wrong: it implies team mode works. The hook
// has no fetch at all, so it is unavailable in BOTH modes.
//
// Rebuilding it is cheap now and worth doing, because the injected block is
// otherwise invisible. A whole debugging session was spent reasoning about what
// memory would inject without being able to look at it.
//
// FIDELITY IS THE WHOLE POINT. A preview that approximates is worse than none —
// it invites conclusions about behaviour it does not actually reproduce. So this
// makes the SAME call SessionStart makes (POST /v1/search, EMPTY query = "list
// recent") and applies the SAME packing rule (join non-empty contents with a
// blank line), mirroring fetchPrimaryInjection in src/cli/handlers/context.ts.
//
// It deliberately does NOT re-implement frameMemory(): that wraps per-prompt
// retrieval, which is a different path with a different shape. Previewing the
// wrong one would be exactly the approximation this is avoiding.

export interface PreviewObservation { content?: unknown }

/**
 * Pack observations the way SessionStart does.
 *
 * Extracted as a pure function so the rule can be tested against the handler's
 * behaviour without a server, and so any future change to one is visibly a
 * change to the other.
 */
export function packContextPreview(observations: PreviewObservation[]): string {
  return observations
    .map(o => o.content)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n\n');
}

export interface ContextPreviewResult {
  /** The block SessionStart would inject, verbatim. */
  preview: string;
  /** How many observations it is built from. */
  count: number;
  /** Set when the preview could not be produced. */
  error: string | null;
}

/**
 * Fetch the live preview.
 *
 * Never throws: this renders inside a settings pane, and a failed preview must
 * degrade to a readable message rather than take the pane down.
 */
export async function fetchContextPreview(
  limit: number,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<ContextPreviewResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch('/v1/search', {
      method: 'POST',
      // The viewer authenticates by loopback cookie; without this the request
      // 401s and the pane reports "unavailable" for an auth reason it cannot
      // explain — the same failure the Runtime tile hit.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      // Empty query is not a mistake: /v1/search treats it as "list recent",
      // which is precisely what SessionStart asks for.
      body: JSON.stringify({ query: '', limit }),
    });
    if (!res.ok) {
      return { preview: '', count: 0, error: `preview unavailable (HTTP ${res.status})` };
    }
    const body = (await res.json()) as { observations?: unknown };
    const observations = Array.isArray(body?.observations) ? body.observations as PreviewObservation[] : [];
    return { preview: packContextPreview(observations), count: observations.length, error: null };
  } catch (err) {
    return {
      preview: '',
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
