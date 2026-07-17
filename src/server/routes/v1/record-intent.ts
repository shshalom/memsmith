// src/server/routes/v1/record-intent.ts
// SPDX-License-Identifier: Apache-2.0
import { computeContentIdempotencyKey } from '../../../services/retrieval/record-intent-key.js';
import { buildUserNoteRequest } from '../../../services/retrieval/user-note-write.js';

export const RECORD_INTENT_SYSTEM = [
  'You decide whether the user is asking to SAVE/RECORD something to memory',
  '(remember, record, log, park, mark, save, note for later, etc. — any phrasing).',
  'If YES, reply exactly "RECORD: " followed by a self-contained one-paragraph note',
  'capturing what to remember (resolve pronouns; make it standalone).',
  'If NO, reply exactly "NONE". Reply with nothing else.',
].join(' ');

export interface RecordIntentDeps {
  complete: (system: string, user: string) => Promise<string | null>;
  write: (o: { projectId: string; teamId: string; kind: string; content: string; metadata: Record<string, unknown>; idempotencyKey: string; embeddingVec?: number[] | null }) => Promise<{ id: string }>;
  teamId: string;
  projectId: string;
}

export async function classifyAndComposeRecordIntent(prompt: string, deps: RecordIntentDeps): Promise<{ recorded: boolean; content?: string; id?: string }> {
  const reply = await deps.complete(RECORD_INTENT_SYSTEM, prompt);
  if (!reply) return { recorded: false };
  const m = reply.trim().match(/^RECORD:\s*([\s\S]+)$/i);
  if (!m) return { recorded: false };
  const content = m[1].trim();
  if (!content) return { recorded: false };
  // Key off the user's PROMPT (deterministic across retries) rather than the
  // LLM-composed content (nondeterministic: same prompt → different wording
  // each call → different hash → duplicate rows). The composed content is still
  // written as the observation body; only the dedup key changes.
  // KNOWN LIMITATION: cross-layer dedup (agent layer vs this backstop) is NOT
  // guaranteed — the agent composes its own note without a prompt-derived key.
  // This fix addresses backstop-vs-itself duplication (retries / duplicate fires).
  const idempotencyKey = computeContentIdempotencyKey({ teamId: deps.teamId, projectId: deps.projectId, kind: 'user_note', content: prompt });
  const noteReq = buildUserNoteRequest(content, { projectId: deps.projectId, idempotencyKey });
  const written = await deps.write({
    projectId: deps.projectId,
    teamId: deps.teamId,
    kind: noteReq.kind as string,
    content: noteReq.content,
    metadata: noteReq.metadata as Record<string, unknown>,
    idempotencyKey: idempotencyKey,
  });
  return { recorded: true, content, id: written.id };
}
