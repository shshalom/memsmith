// SPDX-License-Identifier: Apache-2.0
//
// Pool-free generate-one-event core. Extracted from the generate-and-persist
// half of ProviderObservationGenerator.generateAndPersist (:282-392) for the
// laptop runtime, which has neither an outbox row nor an api_keys table.
// Everything in ProviderObservationGenerator that touches `pool` —
// loadCanonicalOutbox (:398), isApiKeyRevoked (:463), lockOutbox (:580),
// loadEvents (:621), loadProject (:658), and the persist/audit pipeline in
// processGeneratedResponse — is job-queue bookkeeping that this module does
// not do. This module only does the part that is portable: build the
// context, call the provider, parse the response. The caller (a laptop-side
// queue drainer) owns persistence and retry policy.

import type { PostgresAgentEvent } from '../../storage/postgres/agent-events.js';
import type { PostgresObservationGenerationJob } from '../../storage/postgres/generation-jobs.js';
import type { ServerGenerationContext, ServerGenerationProvider } from '../../server/generation/providers/shared/types.js';
import { parseAgentXml, type ParsedObservation } from '../../sdk/parser.js';

export interface GenerateOneInput {
  readonly provider: ServerGenerationProvider;
  readonly event: unknown;
  readonly projectId: string;
  readonly teamId: string;
  readonly serverSessionId?: string | null;
  readonly projectName?: string | null;
}

// The queued event already carries eventType/occurredAtEpoch/payload (it was
// spooled from the same shape agent-events.ts produces); sourceAdapter may or
// may not be present depending on the capture path, so it defaults to
// 'hook' — the platform-source value for a laptop-side hook capture.
interface QueuedEventShape {
  id?: unknown;
  eventType?: unknown;
  occurredAtEpoch?: unknown;
  payload?: unknown;
  sourceAdapter?: unknown;
}

export async function generateOne(input: GenerateOneInput): Promise<ParsedObservation[]> {
  const correlationId = `laptop:${cryptoRandomId()}`;
  return (await generateOneWithOutcome(input, buildContext(input, correlationId), correlationId)).observations;
}

/** Build the provider context for one queued event. Shared by both entry
 *  points so the synthesised `job`/`events` shapes exist in exactly one place. */
function buildContext(input: GenerateOneInput, correlationId: string): ServerGenerationContext {
  const rawEvent = (input.event ?? {}) as QueuedEventShape;

  // Only these five fields are ever read by the shared prompt builder
  // (buildEventBlock in providers/shared/prompt-builder.ts:118-146): id,
  // eventType, sourceAdapter, occurredAtEpoch, payload. Everything else on
  // PostgresAgentEvent (projectId, teamId, serverSessionId, sourceEventId,
  // idempotencyKey, platformSource, metadata, receivedAtEpoch,
  // createdAtEpoch) is never read on this path, so it is safe to synthesize
  // a minimal object and cast — mirroring the same justified cast used below
  // for `job`.
  const event = {
    id: rawEvent.id ?? correlationId,
    eventType: rawEvent.eventType ?? 'unknown',
    occurredAtEpoch: typeof rawEvent.occurredAtEpoch === 'number' ? rawEvent.occurredAtEpoch : Date.now(),
    payload: rawEvent.payload ?? {},
    sourceAdapter: typeof rawEvent.sourceAdapter === 'string' ? rawEvent.sourceAdapter : 'hook',
  } as unknown as PostgresAgentEvent;

  // Only job.id is ever read (prompt-builder.ts:90, as <generation_job_id>).
  // A laptop has no outbox row, so we synthesise a correlation id. Verified
  // by exhaustive grep of providers/ + shared/ — no other job field is
  // consumed.
  const job = { id: correlationId } as unknown as PostgresObservationGenerationJob;

  return {
    job,
    events: [event],
    project: {
      projectId: input.projectId,
      teamId: input.teamId,
      serverSessionId: input.serverSessionId ?? null,
      projectName: input.projectName ?? null,
    },
  };
}

/**
 * Why a generation attempt produced what it did.
 *
 * Zero observations is AMBIGUOUS, and the two causes need OPPOSITE handling:
 *   'skipped'     — the model emitted a valid `<skip_summary />`: a deliberate
 *                   "this event is not worth recording", which
 *                   prompt-builder.ts:82 explicitly asks for. CONSUME the
 *                   event; retrying would loop forever on every trivial tool
 *                   call.
 *   'unparseable' — empty or malformed provider output: a FAULT. KEEP the event
 *                   queued and retry.
 *
 * Verified against the real parser: parseAgentXml('<skip_summary />') is valid
 * with 0 observations, while parseAgentXml('') is invalid. The server path
 * relies on the same distinction (ProviderObservationGenerator.ts:328-330).
 */
export type GenerateOneOutcome = 'generated' | 'skipped' | 'unparseable';

export interface GenerateOneResult {
  observations: ParsedObservation[];
  outcome: GenerateOneOutcome;
}

/**
 * Generate for one event and report WHY the result is what it is.
 *
 * The outcome travels in the RETURN VALUE, not module-level state: the drain
 * loop is sequential today so a "last outcome" global would work, and would
 * corrupt silently the moment anyone parallelises it.
 */
export async function generateOneWithOutcome(
  input: GenerateOneInput,
  prebuiltContext?: ServerGenerationContext,
  prebuiltCorrelationId?: string,
): Promise<GenerateOneResult> {
  const correlationId = prebuiltCorrelationId ?? `laptop:${cryptoRandomId()}`;
  const context = prebuiltContext ?? buildContext(input, correlationId);

  // Errors propagate: the caller decides whether to requeue. Swallowing here
  // would silently drop events the provider failed to generate for.
  const result = await input.provider.generate(context);

  const parsed = parseAgentXml(result.rawText, correlationId);
  if (!parsed.valid) return { observations: [], outcome: 'unparseable' };

  const observations = parsed.observations ?? [];
  return {
    observations,
    outcome: observations.length === 0 ? 'skipped' : 'generated',
  };
}

function cryptoRandomId(): string {
  // Avoid pulling in node:crypto's randomUUID just for a log-correlation
  // string; Math.random is fine here since this id is never a security
  // boundary (unlike, say, an idempotency key).
  return Math.random().toString(36).slice(2);
}
