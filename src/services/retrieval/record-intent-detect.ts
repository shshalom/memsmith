// Deterministic record-intent detector. Biased toward recall: better to
// occasionally re-tag than to miss a user-directed note. Pure; never throws.
const RECORD_PATTERNS: RegExp[] = [
  /\bremember (that|to)?\b/,
  /\b(please )?record (that|this)?\b/,
  /\blog (that|this)\b/,
  /\bpark (this|that|it)\b/,
  /\bmark (this|that)\b/,
  /\bsave (this|that|it)\b/,
  /\bnote (this|that|for later)\b/,
  /\bmake a note\b/,
  /\bkeep in mind (that)?\b/,
  /\bdon'?t forget (that|to)?\b/,
];

export function isRecordIntent(prompt: string): boolean {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim().toLowerCase();
  if (!t) return false;
  return RECORD_PATTERNS.some((re) => re.test(t));
}
