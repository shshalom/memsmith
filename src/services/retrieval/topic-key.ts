// src/services/retrieval/topic-key.ts
// SPDX-License-Identifier: Apache-2.0
//
// A stable identity for "what subject is this search about".
//
// The friction bound of always-memory-first — at most one block per topic per
// session — rests entirely on this function. Too coarse and one memory call
// unlocks every later search; too fine and `grep foo` then `grep foo|bar`
// blocks twice for the same subject. Getting this wrong reproduces the July
// over-blocking failure by a different route.
//
// Deliberately lossy: lowercase, strip regex/glob punctuation, drop sub-3-char
// terms, dedupe, sort. So `spawn|exec|ollama` and `ollama exec spawn` are one
// topic, while `ollama restart` and `postgres pool` are not.

const PUNCT = /[*?{}[\]()^$\\|.+/'"`~!@#%&=:;,<>-]+/g;

/** Minimum term length. 1-2 char tokens ('a', 'an', 'ts') carry no topic signal
 *  and would otherwise let an incidental token split one topic into two. */
const MIN_TERM_LENGTH = 3;

export function topicKey(derivedQuery: string): string {
  const terms = derivedQuery
    .toLowerCase()
    .replace(PUNCT, ' ')
    .split(/\s+/)
    .filter(t => t.length >= MIN_TERM_LENGTH);
  return [...new Set(terms)].sort().join(' ');
}

/**
 * Fraction of the SMALLER term set that must overlap for two topics to count as
 * the same subject.
 *
 * Measured against the smaller set deliberately, so a narrow follow-up
 * ("ollama restart") matches a broad consulted topic ("ollama restart ensure
 * running backoff") and vice versa — both are the same investigation.
 *
 * 0.5 was chosen so two shared terms out of three match, but a single
 * incidental shared word ("server") across otherwise unrelated subjects does
 * not.
 */
const OVERLAP_THRESHOLD = 0.5;

/**
 * Has this topic effectively already been consulted?
 *
 * Exact key matching proved too fine-grained in real use: investigating ONE
 * subject produces several rephrased searches, and each rephrasing hashed to a
 * different key, so each one re-blocked. Measured live — three consecutive
 * blocks on a single investigation within minutes of enabling enforcement.
 *
 * Overlap matching fixes that without loosening the gate for genuinely new
 * subjects: a query counts as consulted when it shares at least
 * OVERLAP_THRESHOLD of the smaller term set with something already consulted.
 * A single shared incidental term is not enough.
 */
export function sameTopic(topic: string, consulted: readonly string[]): boolean {
  if (!topic) return false;
  const terms = new Set(topic.split(' ').filter(Boolean));
  if (terms.size === 0) return false;

  for (const prior of consulted) {
    if (!prior) continue;
    if (prior === topic) return true;
    const priorTerms = new Set(prior.split(' ').filter(Boolean));
    if (priorTerms.size === 0) continue;
    let shared = 0;
    for (const t of terms) if (priorTerms.has(t)) shared++;
    // Require MORE than one shared term, so an incidental single-word collision
    // between unrelated subjects never unlocks the gate.
    if (shared < 2 && terms.size > 1 && priorTerms.size > 1) continue;
    if (shared / Math.min(terms.size, priorTerms.size) >= OVERLAP_THRESHOLD) return true;
  }
  return false;
}
