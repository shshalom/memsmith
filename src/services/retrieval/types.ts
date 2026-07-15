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
}

/** Everything the broker needs, injected so it stays testable with fakes. */
export interface BrokerDeps {
  runtime: RuntimeContext;
  settings: Record<string, string>;
  sessionId: string;
  /** ISO timestamp; injected (not read from clock) so tests are deterministic. */
  nowIso: string;
}
