// SPDX-License-Identifier: Apache-2.0
//
// The local generation loop: drains Task 1's queue (events awaiting
// generation), runs each through Task 4's pool-free generateOne, and POSTs
// every resulting observation to the server via ServerClient.addObservation.
//
// Every dependency (read, clear, generate, post) is injected so this loop is
// testable with no Ollama, no server, and no filesystem — the caller wires
// real implementations (readGenerationQueue, generateOne bound to a live
// provider, ServerClient#addObservation) at the process boundary.
//
// Two failure classes are treated OPPOSITELY, both deliberately:
//
//   - Generation throws, or post() throws for any reason OTHER than the
//     server's quality-floor rejection (HTTP 422) — the event is KEPT
//     queued. This is the durability the queue exists for: a transient
//     Ollama crash or a flaky network must not lose the observation.
//
//   - post() throws with status 422 — the server's ingest-quality gate
//     (Task 3) has scored this observation below the team floor and
//     rejected it. That is a correct, deliberate drop, not a retryable
//     failure: requeuing a sub-floor observation would just fail the same
//     way forever. It counts as generated/consumed, not failed.
//
// After a pass, the queue file is rewritten to contain EXACTLY the kept
// entries (partition-and-rewrite) rather than being cleared unconditionally
// — clearing unconditionally would delete entries that are still waiting to
// be retried.

import type { ParsedObservation } from '../../sdk/parser.js';

/** The minimal shape drainGenerationQueue needs from a queued entry to
 *  build a server request if generation succeeds. Queued entries are
 *  whatever was spooled by enqueueForGeneration — typically carrying at
 *  least projectId — so this is intentionally loose or a raw pass-through. */
type QueuedEntry = unknown;

export interface DrainGenerationQueueDeps {
  /** Read all queued entries. Mirrors readGenerationQueue's signature. */
  read: () => QueuedEntry[];
  /** Clear the queue file entirely. Mirrors clearGenerationQueue. Only
   *  called by the loop itself when there is nothing left to keep and no
   *  writeKept override was supplied (see writeKept below). */
  clear: () => void;
  /** Optional: rewrite the queue to contain exactly the kept subset. When
   *  omitted, the loop falls back to clear()+read-modify-write semantics
   *  are not available, so it uses clear() only when kept is empty and
   *  otherwise expects the caller to have supplied writeKept — production
   *  wiring always supplies writeGenerationQueue from local-queue.ts. */
  writeKept?: (kept: QueuedEntry[]) => void;
  /** Generate observations for one queued event. Propagates provider
   *  errors by design (Task 4) — the loop is what decides to keep-vs-drop. */
  generate: (event: QueuedEntry) => Promise<ParsedObservation[] | GenerateResultLike>;
  /** POST one finished observation to the server. Throws on failure; a
   *  thrown error with `status === 422` is a quality-floor rejection
   *  (correct drop), anything else means the event must stay queued. */
  post: (observation: BuiltObservationRequest) => Promise<void>;
  /** Optional observer for the empty-generation case, so the caller can log
   *  it without this module importing a logger (it is deliberately free of
   *  filesystem/network/logging dependencies so it stays trivially testable).
   *  A provider that returns nothing is a real condition worth surfacing —
   *  silently retrying forever would be its own stranding bug. */
  onEmptyGeneration?: (event: QueuedEntry) => void;
  /** Optional observer for a DELIBERATE skip (`<skip_summary />`). Distinct
   *  from onEmptyGeneration: this event is consumed, not retried, so it should
   *  be logged at debug level rather than as a warning. */
  onSkippedGeneration?: (event: QueuedEntry) => void;
}

/** The payload handed to `post`, carrying the parsed observation's
 *  structured fields in `metadata` — the quality gate at /v1/memories
 *  scores metadata.facts/narrative/concepts/title/obsType, NOT a flattened
 *  content string, so those fields MUST land in metadata or every
 *  observation scores ~0 and is rejected. */
export interface BuiltObservationRequest {
  projectId?: string;
  content: string;
  obsType?: string;
  metadata: Record<string, unknown>;
}

/**
 * What `generate` may resolve with. A bare array keeps every existing caller
 * and test working; the richer shape lets the caller distinguish a deliberate
 * `<skip_summary />` (consume) from an empty/garbled provider response (retry).
 * Both yield zero observations, so the array alone cannot tell them apart.
 */
export interface GenerateResultLike {
  observations: ParsedObservation[];
  outcome: 'generated' | 'skipped' | 'unparseable';
}

export interface DrainGenerationQueueResult {
  /** Observations successfully generated and either posted, or correctly
   *  dropped by the server's quality gate (422). */
  generated: number;
  /** Queued entries whose generation or post attempt failed for a reason
   *  other than a 422 quality-floor rejection; these remain queued. */
  failed: number;
  /** Count of queue entries still in the queue file after this pass —
   *  always equal to `failed` (every non-failed entry is consumed). */
  kept: number;
}

/** Read a HTTP-style status code off a thrown error, in the same shape
 *  ServerClientError exposes it (`status: number | null`) and in the same
 *  shape the brief's fixtures throw it (`Error & { status?: number }`). */
function statusOf(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function isQualityFloorRejection(err: unknown): boolean {
  return statusOf(err) === 422;
}

/** Build the server request for one parsed observation, folding its
 *  structured fields into `metadata` (what the quality gate reads) rather
 *  than the flattened content string. `content` still needs a string —
 *  the narrative is the closest analogue to the observation's body text;
 *  title is the fallback when narrative is absent so `content` is never
 *  empty. */
function buildObservationRequest(projectId: unknown, observation: ParsedObservation): BuiltObservationRequest {
  const content = observation.narrative ?? observation.title ?? '';
  return {
    ...(typeof projectId === 'string' ? { projectId } : {}),
    content,
    obsType: observation.type,
    metadata: {
      obsType: observation.type,
      title: observation.title,
      facts: observation.facts,
      narrative: observation.narrative,
      concepts: observation.concepts,
    },
  };
}

function projectIdOf(event: QueuedEntry): unknown {
  if (event && typeof event === 'object' && 'projectId' in event) {
    return (event as { projectId?: unknown }).projectId;
  }
  return undefined;
}

export async function drainGenerationQueue(
  deps: DrainGenerationQueueDeps,
): Promise<DrainGenerationQueueResult> {
  const queued = deps.read();

  let generated = 0;
  const kept: QueuedEntry[] = [];

  for (const event of queued) {
    let observations: ParsedObservation[];
    let outcome: GenerateResultLike['outcome'];
    try {
      const raw = await deps.generate(event);
      if (Array.isArray(raw)) {
        observations = raw;
        // A bare array cannot say WHY it is empty. Assume the safe reading —
        // 'unparseable', i.e. retry — so a caller that has not adopted the
        // richer shape never silently discards an event.
        outcome = raw.length > 0 ? 'generated' : 'unparseable';
      } else {
        observations = raw.observations;
        outcome = raw.outcome;
      }
    } catch {
      // Generation failed (e.g. Ollama down). Keep the event queued —
      // durability is the whole point of the queue.
      kept.push(event);
      continue;
    }

    // ZERO OBSERVATIONS HAS TWO CAUSES THAT NEED OPPOSITE HANDLING.
    // Both were conflated in the first cut of this loop, and CAUGHT LIVE in
    // Task 7: Ollama replied `<skip_summary />`, the post loop below never ran,
    // nothing was posted — and the event was still counted as generated and
    // DELETED. Work vanished with no error and no trace, the stranding failure
    // class this project has hit repeatedly.
    if (observations.length === 0) {
      if (outcome === 'skipped') {
        // The model deliberately declined this event (a valid
        // `<skip_summary />`, which prompt-builder.ts:82 explicitly asks for on
        // trivial events). CONSUME it: retrying a considered "no" would loop
        // forever on every uninteresting tool call.
        deps.onSkippedGeneration?.(event);
        continue;
      }
      // Empty or malformed provider output is a FAULT, not a verdict. Keep the
      // event queued so a transient fault is retried rather than swallowed.
      deps.onEmptyGeneration?.(event);
      kept.push(event);
      continue;
    }

    // Post every observation generated from this event. If ANY post fails
    // for a non-422 reason, the source event is kept queued so the whole
    // event (and everything it would generate) is retried together.
    let eventFailed = false;
    for (const observation of observations) {
      const request = buildObservationRequest(projectIdOf(event), observation);
      try {
        await deps.post(request);
      } catch (err) {
        if (isQualityFloorRejection(err)) {
          // Correct drop: the server judged this observation low-signal.
          // Requeuing it would loop forever, so it counts as consumed.
          continue;
        }
        eventFailed = true;
        break;
      }
    }

    if (eventFailed) {
      kept.push(event);
    } else {
      generated += 1;
    }
  }

  if (kept.length === 0) {
    deps.clear();
  } else if (deps.writeKept) {
    deps.writeKept(kept);
  } else {
    // No writeKept supplied: fall back to clear+nothing rather than
    // silently deleting entries that must survive. Production callers
    // always pass writeGenerationQueue (local-queue.ts), so this branch
    // only matters for callers that opt out of durability deliberately.
  }

  return { generated, failed: kept.length, kept: kept.length };
}
