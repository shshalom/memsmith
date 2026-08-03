// SPDX-License-Identifier: Apache-2.0
//
// The context preview must show what SessionStart ACTUALLY injects.
//
// It was a deliberate no-op: useContextPreview returned empty state and the
// message "Context preview is not available on the local runtime." Its endpoints
// (/api/projects, /api/context/preview) died with the legacy worker. The message
// was also wrong — it implies team mode works, but the hook had no fetch at all,
// so the preview was unavailable in BOTH modes.
//
// FIDELITY IS THE WHOLE POINT. A preview that approximates is worse than none: it
// invites conclusions about behaviour it does not reproduce. A full debugging
// session earlier went into reasoning about the injected block without being able
// to see it — a preview that showed something *close* would have made that worse,
// not better.
//
// So the tests below pin the preview to the handler's real behaviour: same route,
// same empty-query convention, same packing rule. If fetchPrimaryInjection changes
// and the preview does not, these fail.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { packContextPreview, fetchContextPreview } from '../../src/ui/viewer/utils/contextPreview.js';

const REPO = join(import.meta.dir, '..', '..');
const HANDLER = readFileSync(join(REPO, 'src/cli/handlers/context.ts'), 'utf-8');

function okResponse(observations: unknown[]) {
  return async () => ({ ok: true, status: 200, json: async () => ({ observations }) }) as never;
}

describe('packContextPreview matches the handler packing rule', () => {
  it('joins contents with a blank line', () => {
    expect(packContextPreview([{ content: 'a' }, { content: 'b' }])).toBe('a\n\nb');
  });

  it('drops empty and non-string contents, as the handler does', () => {
    // fetchPrimaryInjection filters on `typeof text === 'string' && text.length > 0`.
    const packed = packContextPreview([
      { content: 'kept' }, { content: '' }, { content: null }, { content: 42 }, {},
    ]);
    expect(packed).toBe('kept');
  });

  it('returns empty string for no observations, not a placeholder', () => {
    // An empty corpus must look empty. Inventing text here would be the preview
    // showing something the session would never inject.
    expect(packContextPreview([])).toBe('');
  });

  it('the handler still uses this exact rule', () => {
    // Pins the two together: if fetchPrimaryInjection's filter or join changes,
    // this fails rather than the preview silently drifting out of fidelity.
    expect(HANDLER).toContain("typeof text === 'string' && text.length > 0");
    expect(HANDLER).toContain(".join('\\n\\n')");
  });
});

describe('fetchContextPreview calls what SessionStart calls', () => {
  it('POSTs /v1/search with an EMPTY query', async () => {
    // Empty query is /v1/search's "list recent" convention — the same request
    // SessionStart makes. POST /v1/context would 400 here: it requires a
    // non-empty query and is the per-prompt path, a different shape entirely.
    let seen: { url?: string; body?: unknown } = {};
    await fetchContextPreview(10, {
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(String(init.body)) };
        return { ok: true, status: 200, json: async () => ({ observations: [] }) };
      }) as never,
    });
    expect(seen.url).toBe('/v1/search');
    expect(seen.body).toEqual({ query: '', limit: 10 });
  });

  it('sends the project cookie', async () => {
    // Without credentials the request 401s and the pane reports "unavailable"
    // for an auth reason it cannot explain — the failure the Runtime tile hit.
    let creds: string | undefined;
    await fetchContextPreview(5, {
      fetch: (async (_u: string, init: RequestInit) => {
        creds = init.credentials;
        return { ok: true, status: 200, json: async () => ({ observations: [] }) };
      }) as never,
    });
    expect(creds).toBe('include');
  });

  it('honours the requested limit', async () => {
    let body: { limit?: number } = {};
    await fetchContextPreview(3, {
      fetch: (async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, json: async () => ({ observations: [] }) };
      }) as never,
    });
    expect(body.limit).toBe(3);
  });

  it('returns the packed block and a count', async () => {
    const out = await fetchContextPreview(10, {
      fetch: okResponse([{ content: 'one' }, { content: 'two' }]),
    });
    expect(out).toEqual({ preview: 'one\n\ntwo', count: 2, error: null });
  });
});

describe('fetchContextPreview degrades rather than throwing', () => {
  it('reports a non-OK status instead of rendering a broken pane', async () => {
    const out = await fetchContextPreview(10, {
      fetch: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never,
    });
    expect(out.error).toMatch(/401/);
    expect(out.preview).toBe('');
  });

  it('never throws on a network failure', async () => {
    const out = await fetchContextPreview(10, {
      fetch: (async () => { throw new Error('offline'); }) as never,
    });
    expect(out.error).toMatch(/offline/);
    expect(out.preview).toBe('');
  });

  it('tolerates a malformed body without crashing', async () => {
    const out = await fetchContextPreview(10, {
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ observations: 'nope' }) })) as never,
    });
    expect(out).toEqual({ preview: '', count: 0, error: null });
  });
});

describe('the dead no-op is gone', () => {
  const hook = readFileSync(join(REPO, 'src/ui/viewer/hooks/useContextPreview.ts'), 'utf-8');

  it('no longer hardcodes the "not available" message', () => {
    // It claimed the preview was a local-runtime limitation. It was not: the
    // hook had no fetch at all, so it was unavailable in team mode too.
    const code = hook.replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('not available on the local runtime');
  });

  it('actually fetches', () => {
    expect(hook).toContain('fetchContextPreview');
  });

  it('is keyed on the same setting SessionStart reads', () => {
    // Editing the count and watching the preview change is a direct check that
    // MEMSMITH_CONTEXT_SESSION_COUNT works.
    expect(hook).toContain('MEMSMITH_CONTEXT_SESSION_COUNT');
    expect(HANDLER).toContain('MEMSMITH_CONTEXT_SESSION_COUNT');
  });
});
