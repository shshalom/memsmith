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
