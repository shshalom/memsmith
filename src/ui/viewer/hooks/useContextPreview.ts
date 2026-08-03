import { useState, useEffect } from 'react';
import type { Settings } from '../types';
import { fetchContextPreview } from '../utils/contextPreview.js';

// Worker retirement left this hook a deliberate no-op: the preview used to fetch
// `/api/projects` and `/api/context/preview` from the legacy worker, both of which
// died with it. Rather than hang, it returned empty state and the message
// "Context preview is not available on the local runtime."
//
// That message was also WRONG. It implies team mode works — but the hook had no
// fetch at all, so the preview was unavailable in BOTH modes. A user reading it
// would reasonably conclude the feature exists somewhere it does not.
//
// It is live again because the data is now one call away: SessionStart injects
// the result of POST /v1/search with an EMPTY query ("list recent"), packed by
// joining non-empty contents. fetchContextPreview makes that same call and
// applies that same rule, so what the pane shows is what gets injected — not an
// approximation of it.
//
// Why it matters: the injected block is otherwise invisible. An entire debugging
// session went into reasoning about what memory would inject without being able
// to look at it.

interface UseContextPreviewResult {
  preview: string;
  isLoading: boolean;
  error: string | null;
  /** How many observations the preview is built from. */
  count: number;
  /** Re-run the preview — used after changing the observation count. */
  refresh: () => void;
}

/** Mirrors resolveSessionStartLimit in src/cli/handlers/context.ts. */
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

function resolveLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

export function useContextPreview(settings: Settings): UseContextPreviewResult {
  const [preview, setPreview] = useState('');
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Keyed on the SAME setting SessionStart reads, so editing the count and
  // watching the preview change is a direct check that the setting works.
  const limit = resolveLimit(settings?.MEMSMITH_CONTEXT_SESSION_COUNT);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void fetchContextPreview(limit).then(result => {
      if (cancelled) return;
      setPreview(result.preview);
      setCount(result.count);
      setError(result.error);
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [limit, nonce]);

  return {
    preview,
    isLoading,
    error,
    count,
    refresh: () => setNonce(n => n + 1),
  };
}
