// SPDX-License-Identifier: Apache-2.0
// Deterministic, dependency-free query expansion. Turns an obliquely-phrased
// question into content-term variants that embed closer to the answer text —
// the single-session failure mode surfaced by the LongMemEval diagnostic
// (all-MiniLM ranked answers 17-26 when the question shared little vocabulary
// with the answer). No LLM, no network: pure string transforms.

// Leading interrogative framings to strip, longest-first so multi-word frames
// match before their prefixes. All matched case-insensitively at the start.
const FRAMINGS = [
  'can you please recommend',
  'can you recommend some',
  'can you recommend a',
  'can you recommend',
  'can you suggest some',
  'can you suggest',
  'can you tell me',
  'can you give me',
  'could you recommend',
  'could you tell me',
  'do you remember',
  'do you know',
  'what was my',
  'what were my',
  'what is my',
  'what are my',
  'what did i',
  'what do i',
  'how long is my',
  'how long is',
  'how many',
  'how much',
  'how do i',
  'how did i',
  'when did i',
  'when is my',
  'where did i',
  'where is my',
  'which of my',
  'tell me about my',
  'tell me about',
  'remind me',
  'i want to know',
  'i would like to know',
  "i'm thinking of",
  'what',
  'when',
  'where',
  'which',
  'how',
  'why',
  'who',
];

// Trailing framing fragments left behind after leading-frame removal that carry
// no retrieval signal (e.g. "... for me to watch tonight?" -> keep "to watch").
const TRAILING_NOISE = [
  'for me',
  'for myself',
  'that i might find interesting',
  'that i would find interesting',
  'i might find interesting',
  'around me',
  'right now',
];

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function deframe(query: string): string {
  let q = norm(query).replace(/[?]+\s*$/g, '');
  const lower = q.toLowerCase();
  for (const f of FRAMINGS) {
    if (lower.startsWith(f + ' ')) {
      q = q.slice(f.length + 1);
      break;
    }
  }
  let out = norm(q);
  let lo = out.toLowerCase();
  for (const t of TRAILING_NOISE) {
    if (lo.endsWith(' ' + t)) {
      out = norm(out.slice(0, out.length - t.length));
      lo = out.toLowerCase();
    }
  }
  return out;
}

/**
 * Expand a query into 1..N variants for multi-query retrieval. Variant 0 is
 * always the original query verbatim; a de-framed content-term variant is
 * appended when it differs. Deterministic and dependency-free.
 */
export function expandQuery(query: string): string[] {
  const original = norm(query);
  const variants = [original];
  const deframed = deframe(query);
  if (deframed && deframed.toLowerCase() !== original.toLowerCase()) {
    variants.push(deframed);
  }
  // Dedup while preserving order and dropping empties.
  const seen = new Set<string>();
  return variants.filter(v => {
    const key = v.toLowerCase();
    if (!v.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
