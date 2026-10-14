// src/services/retrieval/info-request.ts
// SPDX-License-Identifier: Apache-2.0
//
// Is this prompt a request for information about past work? Such prompts must
// be answered from a memory search, not from the session-start context. Pure and
// deterministic; never throws. When a prompt is ambiguous between a question and
// a task it classifies as 'info-request' — a wrongly gated task costs one memory
// search, a wrongly ungated question costs an answer nobody checked.

import { stripMemoryTags } from '../../utils/tag-stripping.js';

export type PromptKind = 'info-request' | 'conversation' | 'task';

const CONVERSATION: RegExp[] = [
  /\byou (just )?(said|mentioned|wrote|suggested|proposed|listed|described|explained)\b/,
  /\bwhat (did )?you (just )?(mean|meant|say|said)\b/,
  /\b(see above|as above|(the|that|this|those|these)( \w+){1,3} above|(said|mentioned|wrote|listed|shown|described) above)\b/,
  /\b(earlier|before|previously) in (this|the|our) (chat|conversation|session|thread)\b/,
  /\bin (this|our) (chat|conversation|thread)\b/,
  /\bthe (plan|answer|summary|list|code|draft|proposal|explanation|diff|table|options?) you (just )?(wrote|gave|made|proposed|posted|sent|suggested|drafted|described|listed)\b/,
  /\byour (last|previous|earlier|prior) (message|answer|response|reply|point|comment|suggestion|turn)\b/,
];

const ASKS_TO_BE_TOLD: RegExp[] = [
  /\bremind me\b/,
  /\btell me (about|why|how|what|where|who|which|whether)\b/,
  /\bshow me (how|why|what|where|who|which)\b/,
  /\bexplain (why|how|what|where)\b/,
  /\bdo you (remember|recall|know)\b/,
  /\bwhat do (we|you) know about\b/,
];

const TASK_VERBS = [
  'fix', 'add', 'run', 'implement', 'create', 'write', 'update', 'refactor', 'remove', 'delete',
  'rename', 'build', 'commit', 'push', 'test', 'make', 'change', 'move', 'deploy', 'install',
  'debug', 'review', 'open', 'merge', 'bump', 'generate', 'migrate', 'set up', 'setup', 'configure',
  'continue', 'proceed', 'start', 'stop', 'restart', 'try', 'retry', 'apply', 'revert', 'undo',
  'use', 'replace', 'clean', 'format', 'lint', 'check', 'verify', 'investigate', 'look', 'show',
  'list', 'print', 'draft', 'document', 'edit', 'modify', 'convert', 'split', 'extract', 'wire',
  'enable', 'disable', 'turn', 'go', 'do', 'keep', 'finish', 'ship', 'release', 'rebase',
  'squash', 'stage', 'amend', 'tag', 'publish', 'resolve', 'address', 'handle', 'port', 'optimize',
  'improve', 'simplify', 'summarize', 'expand', 'rewrite', 'tell', 'drop', 'pin', 'mock',
].join('|');

const ACKNOWLEDGEMENTS = 'yes|yep|yeah|ok|okay|sure|no|nope|thanks|thank you|great|cool|lgtm|approved|sounds good|perfect|good|nice|done';

const TASK_START = new RegExp(`^(${TASK_VERBS}|${ACKNOWLEDGEMENTS})\\b`);
const POLITE_TASK = new RegExp(
  `^(please|pls|kindly|let'?s|go ahead and|(can|could|would|will) (you|we))\\b( please)? (${TASK_VERBS})\\b`,
);
const POLITE_PREFIX = /^(please|pls|kindly|let'?s)\b/;

const QUESTION_PHRASES: RegExp[] = [
  /\bwhy\b/,
  /\bwhat (did|have|has|had|was|were)\b/,
  /\bwhat changed\b/,
  /\bwhat happened\b/,
  /\bhow (did|do|does|was|were|have|has|had|is|are)\b/,
  /\bwhen (did|was|were|have|has|had)\b/,
  /\bwho (did|changed|wrote|added|made|decided|fixed|broke|owns|built|removed|is|was)\b/,
  /\bwhere (is|are|was|were|do|does|did|have|has)\b/,
  /\bwhat'?s the (status|state|story|reason|plan)\b/,
  /\bwhat is the (status|state|story|reason|plan)\b/,
  /\bstatus (of|on)\b/,
  /\b(have|did|were|was|had) (we|you|they|i)\b/,
  /\bis there (a|any) (record|note|decision|history)\b/,
];

const INTERROGATIVE_START = /^(what|why|how|when|where|who|whom|whose|which|did|do|does|is|are|was|were|have|has|had|can|could|should|would|will|am)\b/;

const PAST_WORK_TERMS = /\b(rationale|reasoning|decision|decisions|decided|agreed|agreement|history|historically|previously|last time|in the past|post-?mortem)\b/;

const PAST_WORK_PHRASES: RegExp[] = [
  /\brecap\b/,
  /\bcatch me up\b/,
  /\bwhat (we|you|they|\w+) (did|decided|changed|tried|agreed|built|shipped|fixed)\b/,
  /\bhow (we|you|they) (fixed|did|solved|handled|chose|implemented|configured|built)\b/,
  /\bhistory of\b/,
  /\byesterday\b/,
  /\blast (week|session|time|sprint|month|night)\b/,
];

const PAST_QUESTION: RegExp[] = [
  /\b(what|how|why|when|where|who|which) (did|was|were|had|have) (we|you|they|i)\b/,
  /\bwhy (did|was|were|had)\b/,
  /\b(did|have|had) (we|you|they) (ever )?\w+/,
];

/** Past this, a prompt is a brief or a bug report, and a question mark alone
 *  says nothing about past work. */
const LONG_PROMPT_CHARS = 300;

function sentenceCount(t: string): number {
  return t.split(/[.!?]+(?:\s|$)/).filter(part => part.trim().length > 0).length;
}

function hasPastWorkSignal(t: string): boolean {
  return PAST_WORK_TERMS.test(t)
    || PAST_WORK_PHRASES.some(re => re.test(t))
    || PAST_QUESTION.some(re => re.test(t));
}

function normalize(prompt: string): string {
  return stripMemoryTags(prompt)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyPrompt(prompt: string): PromptKind {
  if (typeof prompt !== 'string') return 'task';
  const t = normalize(prompt);
  if (!t || t.startsWith('/')) return 'task';

  if (CONVERSATION.some(re => re.test(t))) return 'conversation';
  if (hasPastWorkSignal(t)) return 'info-request';
  if (t.length > LONG_PROMPT_CHARS || sentenceCount(t) > 1) return 'task';
  if (ASKS_TO_BE_TOLD.some(re => re.test(t))) return 'info-request';
  if (POLITE_TASK.test(t)) return 'task';

  const body = t.replace(POLITE_PREFIX, '').trim();
  const taskStart = TASK_START.test(body);
  const asks = t.includes('?');
  if (taskStart && !asks) return 'task';
  if (QUESTION_PHRASES.some(re => re.test(t))) return 'info-request';
  if (taskStart) return 'task';
  if (asks || INTERROGATIVE_START.test(body)) return 'info-request';
  return 'task';
}

export function isInfoRequest(prompt: string): boolean {
  return classifyPrompt(prompt) === 'info-request';
}
