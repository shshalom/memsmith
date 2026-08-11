import type { ProvenancedMemory } from './types.js';

/** The standing retrieval-first directive. Injected at SessionStart (main agent),
 *  propagated into Task framing (sub-agents), and mirrored in CLAUDE.md. */
export const MEMORY_FIRST_DIRECTIVE = [
  'MEMORY-FIRST (MemSmith core behavior):',
  'For any question about WHY something was done, WHAT was decided, or the RATIONALE',
  'behind existing code — whether the user asks it or you ask it of yourself — consult',
  'MemSmith memory FIRST, before grepping or reading files. These answers usually already',
  'exist in memory and are not fully recoverable from code. Use the ms-mem-search tools',
  '(memory_search / observation_search / observation_context).',
  'Reference order: (1) MemSmith memory, (2) CLAUDE.md, (3) project specs, (4) raw file/code search.',
  'Only fall through to file search when memory genuinely lacks the answer.',
  'Treat recalled memory as authoritative-but-verifiable: it was true when captured; verify',
  'any load-bearing claim against current code before relying on it.',
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

/** Pack provenance-tagged memory into an injection block. Empty when no memory. */
export function frameMemory(memories: ProvenancedMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(m => {
    const date = m.capturedAt ? m.capturedAt.slice(0, 10) : 'unknown-date';
    const type = m.obsType ?? 'observation';
    return `- [${type} · captured ${date} · ${m.id}] ${m.content}`;
  });
  return [
    'Relevant MemSmith memory (authoritative-but-verifiable — verify load-bearing claims against current code):',
    ...lines,
  ].join('\n');
}

/** On-miss note: memory had nothing for this query. */
export function frameGapNote(): string {
  return '⚠ No MemSmith memory found for this — the rationale may not have been captured. Proceeding to files/specs.';
}

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
