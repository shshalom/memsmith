import type { ServerAddObservationRequest } from '../hooks/server-client.js';

/**
 * Build a user-note write request with the tag guarantee enforced.
 * kind='user_note' and metadata.userDirected=true are set LAST, so any
 * caller-supplied kind/userDirected is overridden. Pure; never throws.
 */
export function buildUserNoteRequest(
  content: string,
  opts: { projectId: string; idempotencyKey?: string | null; metadata?: Record<string, unknown> },
): ServerAddObservationRequest {
  const request: ServerAddObservationRequest = {
    projectId: opts.projectId,
    content,
    kind: 'user_note',
    metadata: { ...(opts.metadata ?? {}), userDirected: true },
  };
  if (opts.idempotencyKey !== undefined) request.idempotencyKey = opts.idempotencyKey;
  return request;
}
