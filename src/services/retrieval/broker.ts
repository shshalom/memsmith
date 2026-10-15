// src/services/retrieval/broker.ts
import { SessionTopicStore } from './topic-store.js';
import { topicKey } from './topic-key.js';
import { deriveQueryFromTool } from './query-derivation.js';
import { MEMORY_FIRST_GATE_REASON, MEMORY_FIRST_NUDGE, frameUnavailableNotice } from './directive.js';
import { enforcementModeFromSettings } from './enforcement-mode.js';
import type { BrokerDeps, EnforcementMode, ProvenancedMemory, RetrievalResult } from './types.js';
import { logger } from '../../utils/logger.js';

const EMPTY: RetrievalResult = Object.freeze({ additionalContext: '', block: false, unavailable: false });

const UNAVAILABLE: RetrievalResult = Object.freeze({
  additionalContext: frameUnavailableNotice(), block: false, unavailable: true,
});

async function defaultMemoryReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sentinel to distinguish a server error/unavailable (fail-open) from a genuine empty result. */
const FAILED = Symbol('FAILED');

export class RetrievalBroker {
  private readonly topics: SessionTopicStore;
  constructor(
    private readonly deps: BrokerDeps,
    topicStore?: SessionTopicStore,
  ) {
    this.topics = topicStore ?? new SessionTopicStore(deps.sessionId);
  }

  private minHits(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_MIN_HITS ?? '1', 10) || 1); }
  private limit(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_SEMANTIC_INJECT_LIMIT ?? '5', 10) || 5); }
  private timeoutMs(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_TIMEOUT_MS ?? '2000', 10) || 2000); }
  private mode(): EnforcementMode { return enforcementModeFromSettings(this.deps.settings); }

  /** Query /v1/context with a hard timeout. Returns FAILED sentinel on any error/unavailability (fail-open). */
  private async query(q: string): Promise<ProvenancedMemory[] | typeof FAILED> {
    const rt = this.deps.runtime;
    if (rt.runtime !== 'server') return FAILED;
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        rt.client.contextObservations({ projectId: rt.projectId, query: q, limit: this.limit() }),
        new Promise<never>((_, rej) => { timeoutHandle = setTimeout(() => rej(new Error('retrieval timeout')), this.timeoutMs()); }),
      ]).finally(() => { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); });
      const obs = Array.isArray(result?.observations) ? result.observations : [];
      return obs.map(o => ({
        id: String(o.id),
        content: typeof o.content === 'string' ? o.content : '',
        obsType: typeof (o as any).obs_type === 'string' ? (o as any).obs_type : (typeof (o as any).obsType === 'string' ? (o as any).obsType : null),
        capturedAt:
          typeof (o as any).createdAtEpoch === 'number'
            ? new Date((o as any).createdAtEpoch).toISOString()
            : (typeof (o as any).created_at === 'string' ? (o as any).created_at
               : (typeof (o as any).createdAt === 'string' ? (o as any).createdAt : null)),
      })).filter(m => m.content.length > 0);
    } catch (err) {
      logger.debug('HOOK', 'retrieval query failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
      return FAILED;
    }
  }

  /**
   * Can memory answer right now, and does it hold anything for this prompt?
   * It injects nothing, so an information request is routed to a real memory
   * search instead of being answered from pre-fetched results.
   */
  async probe(promptText: string): Promise<{ unavailable: boolean; isGap: boolean }> {
    if (!promptText || promptText.trim().length === 0) return { unavailable: false, isGap: false };
    const hits = await this.query(promptText);
    if (hits === FAILED) return { unavailable: true, isGap: false };
    return { unavailable: false, isGap: hits.length < this.minHits() };
  }

  /**
   * The memory-first gate for an agent reaching out for information (Grep, Glob,
   * search-style Bash, web search or fetch). It runs no memory query of its own:
   * the agent consults memory by calling the memory tools, and the hook adapter
   * marks the topic consulted when it does. Until then, hard mode blocks once per
   * topic and soft mode reminds; after that, the tool runs without friction.
   * When memory cannot be reached the agent could never unlock the topic, so
   * the gate fails open with a visible notice instead of blocking.
   */
  async forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> {
    const q = deriveQueryFromTool(toolName, toolArgs, { warmPaths: this.deps.warmPaths });
    if (q === null) return EMPTY;
    const topic = topicKey(q);
    if (topic.length === 0 || this.topics.hasConsulted(topic) || this.topics.wasBlocked(topic)) return EMPTY;
    if (this.mode() === 'hard') {
      const rt = this.deps.runtime;
      if (rt.runtime !== 'server') return UNAVAILABLE;
      const reachable = await (this.deps.memoryReachable ?? (() => defaultMemoryReachable(rt.serverBaseUrl)))();
      if (!reachable) return UNAVAILABLE;
      this.topics.markBlocked(topic);
      return { ...EMPTY, block: true, blockReason: MEMORY_FIRST_GATE_REASON };
    }
    return { ...EMPTY, additionalContext: MEMORY_FIRST_NUDGE };
  }
}
