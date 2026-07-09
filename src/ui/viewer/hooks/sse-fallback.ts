export function shouldFallbackToPolling(s: { streamErrored: boolean; reconnecting: boolean }): boolean {
  return s.streamErrored;
}
