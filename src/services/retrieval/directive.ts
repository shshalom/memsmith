import type { EnforcementMode } from './types.js';

/** The standing memory-first directive. Injected at SessionStart (main agent)
 *  and into Task framing (subagents). Memory is consulted when the agent needs
 *  information, so the trigger is the agent's own judgment, not the prompt's words. */
export const MEMORY_FIRST_DIRECTIVE = [
  'MEMORY-FIRST (MemSmith core behavior):',
  'Whenever you need information you do not already have, whether the user asked or you',
  'are asking yourself mid-task, follow this order:',
  '1. Do I already know it from this conversation? If yes, use it; no search needed.',
  '2. If not, remember: search MemSmith memory (observation_search for a ranked index, then',
  '   observation_get for the full records) BEFORE grepping, globbing, or searching the web.',
  '   Memory points you in the right direction even when it is stale, and it holds the why and',
  '   the decisions that code cannot tell you.',
  '3. Validate: check load-bearing claims against the current code before relying on them.',
  'Session-start context is orientation, not the answer source. If memory has no record, say so',
  'and fall back to CLAUDE.md, specs, then code.',
].join('\n');

/** The record-intent directive (Layer 1 — agent detection). Injected at SessionStart
 *  and in PreToolUse:Agent contexts to instruct the agent to recognize user requests
 *  for recording/remembering and automatically capture them as observations. */
export const RECORD_INTENT_DIRECTIVE = [
  'RECORD-INTENT (MemSmith core behavior):',
  'When the user directs you to record/remember/log/park/mark/save/note something to',
  'memory — in ANY natural phrasing — you MUST capture it by calling the note_add tool.',
  'This is the ONLY correct tool for a user-directed note. Do NOT use observation_add',
  'for these; observation_add produces a generic, non-user-directed observation that',
  'will NOT surface in the user\'s notes.',
  'Route ALL of these to note_add (the verb form does not matter — imperative OR',
  'declarative both count):',
  '  • "Save this / park this / mark this / note this: …"',
  '  • "Remember that … / keep in mind that … / don\'t forget that …"',
  '  • "Log that … / note for later that … / record that …"',
  'If in doubt whether the user is directing you to remember something, use note_add.',
  'To capture: compose a SELF-CONTAINED note (resolve "that"/"it" into a standalone',
  'statement), then call note_add with it as `content`. (note_add hard-tags it as a',
  'findable user note automatically — you do not set kind or metadata.) Then echo a',
  'one-line confirmation: "📝 Recorded to memory: <summary>". If the write fails, say',
  'so plainly ("⚠ Couldn\'t record to memory — say it again / I\'ll retry"); never record',
  'the note to a file (TODO.md, CLAUDE.md, etc.) unless the user explicitly asks for a',
  'file. Memory is the record.',
].join('\n');

/** Combined injected directives: memory-first + record-intent.
 *  Used by SessionStart context handler and PreToolUse:Agent handler. */
export const INJECTED_DIRECTIVES = [MEMORY_FIRST_DIRECTIVE, RECORD_INTENT_DIRECTIVE].join('\n\n');

/** Heads the recent observations injected at SessionStart. */
export const SESSION_START_ORIENTATION_LABEL =
  'Latest context for orientation — search memory to answer questions about past work:';

/**
 * Injected on UserPromptSubmit in place of pre-fetched memory when the prompt
 * asks about past work. Pre-fetched top-N results read as a finished answer, so
 * the agent answered from them and never searched; this routes it to the search.
 */
export function frameAnswerFromMemoryDirective(mode: EnforcementMode): string {
  const lines = [
    'ANSWER FROM MEMORY: this prompt asks for information about past work. Unless the answer is',
    'already in this conversation, answer it from a MemSmith memory search, not from the',
    'session-start context or from recall:',
    '1. Call observation_search with the question\'s key terms, then observation_get for the ids that matter.',
    '2. Answer from the results. If memory has no record, say so plainly.',
    '3. Validate load-bearing claims against the current code before relying on them.',
  ];
  if (mode === 'hard') {
    lines.push('Hard mode: an answer given without a memory search is sent back to search first.');
  }
  return lines.join('\n');
}

/** PreToolUse block reason: the agent reached out before remembering. */
export const MEMORY_FIRST_GATE_REASON =
  'Memory first: before searching the code or the web for this, search MemSmith memory '
  + '(observation_search, then observation_get for the ids that matter). Memory can point to the '
  + 'right place even if it is stale; then validate against the code. After searching memory, re-run this. '
  + 'If the MemSmith memory tools are not available in this session, tell the user, then re-run this unchanged.';

/** Soft-mode reminder on the same moment, without blocking. */
export const MEMORY_FIRST_NUDGE =
  'Memory first: if you have not searched MemSmith memory for this yet, do that before relying on '
  + 'this search (observation_search, then observation_get), then validate against the code.';

/** Stop-hook reason when an information request was answered without a memory search. */
export const ANSWER_GATE_BLOCK_REASON =
  'This was a request for information about past work. Search memory (observation_search) '
  + 'before answering, then verify load-bearing claims against the code.';

/**
 * Amendment 2 (2026-08-11) — memory could not be consulted, and the USER must know.
 *
 * Fail-open keeps the agent working; this keeps the failure visible. The original
 * spec logged this at debug level, so an agent whose memory was unreachable would
 * silently revert to grep-first with no signal — indistinguishable from working
 * correctly. If the server were down for a week, every answer in that period would
 * be quietly code-only and the user could not tell which conclusions to distrust.
 */
export function frameUnavailableNotice(): string {
  return [
    '⚠ MemSmith memory is UNAVAILABLE for this query (server unreachable or timed out).',
    'This answer will be code-only and has NOT been checked against recorded memory.',
    'Tell the user memory is unavailable BEFORE answering, and propose the code search',
    'explicitly rather than silently falling back to it.',
  ].join('\n');
}
