import type { RuntimeContext } from '../hooks/runtime-selector.js';

export type EnforcementMode = 'soft' | 'hard';

/** A memory result tagged with provenance for authoritative-but-verifiable framing. */
export interface ProvenancedMemory {
  id: string;
  content: string;
  obsType: string | null;
  capturedAt: string | null;
}

/** The broker's decision for one prompt or tool-intent. */
export interface RetrievalResult {
  /** Text to inject as hookSpecificOutput.additionalContext (may be ''). */
  additionalContext: string;
  /** Hard-mode only: whether to deny the tool once and require a memory consult. */
  block: boolean;
  blockReason?: string;
  /** How many results /v1/context returned for the query. */
  hitCount: number;
  /** True when hitCount < MIN_HITS (a gap was flagged). */
  isGap: boolean;
  /**
   * True when memory could NOT be consulted at all — server unreachable,
   * timeout, unresolvable key, non-server runtime.
   *
   * Deliberately distinct from `isGap`: a gap means memory WAS asked and had
   * nothing recorded (real signal, worth persisting). Unavailable means it was
   * never asked, so counting it as a gap would poison the gap corpus with false
   * gaps. Amendment 2 (2026-08-11) additionally requires this to reach the USER,
   * not just a log line — an agent that silently lost its memory is
   * indistinguishable from one that is working.
   */
  unavailable: boolean;
}

/** Everything the broker needs, injected so it stays testable with fakes. */
export interface BrokerDeps {
  runtime: RuntimeContext;
  settings: Record<string, string>;
  sessionId: string;
  /** ISO timestamp; injected (not read from clock) so tests are deterministic. */
  nowIso: string;
  /**
   * Absolute file paths already in the agent's context this session. A re-read of
   * one of these is not "seeking information", so it is not gated (Amendment 1).
   * Injected rather than read from disk here so the broker stays testable.
   */
  warmPaths?: ReadonlySet<string>;
}
