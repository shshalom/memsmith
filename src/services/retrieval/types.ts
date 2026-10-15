import type { RuntimeContext } from '../hooks/runtime-selector.js';

export type EnforcementMode = 'soft' | 'hard';

/** A memory result tagged with provenance for authoritative-but-verifiable framing. */
export interface ProvenancedMemory {
  id: string;
  content: string;
  obsType: string | null;
  capturedAt: string | null;
}

/** The gate's decision for one tool call. */
export interface RetrievalResult {
  /** Text to inject as hookSpecificOutput.additionalContext (may be ''). */
  additionalContext: string;
  /** Hard-mode only: whether to deny the tool once and require a memory consult. */
  block: boolean;
  blockReason?: string;
  /**
   * True when memory cannot be consulted (non-server runtime or an unreachable
   * server). The gate then fails open, and Amendment 2 (2026-08-11) requires the
   * notice to reach the user: an agent that silently lost its memory is
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
  /** Whether the memory server answers; consulted only before a hard-mode block. */
  memoryReachable?: () => Promise<boolean>;
}
