// src/services/retrieval/broker.ts
import { SessionShownStore } from './session-store.js';
import { SessionTopicStore } from './topic-store.js';
import { topicKey } from './topic-key.js';
import { deriveQueryFromTool } from './query-derivation.js';
import { frameMemory, frameGapNote, frameUnavailableNotice } from './directive.js';
import type { BrokerDeps, EnforcementMode, ProvenancedMemory, RetrievalResult } from './types.js';
import { logger } from '../../utils/logger.js';

const EMPTY: RetrievalResult = Object.freeze({
  additionalContext: '', block: false, hitCount: 0, isGap: false, unavailable: false,
});

/**
 * Amendment 2 — memory was not consulted. Fail OPEN (never block) but NOT silent:
 * the notice reaches the agent's context so it can tell the user. `isGap` stays
 * false because memory was never asked — see RetrievalResult.unavailable.
 */
const UNAVAILABLE: RetrievalResult = Object.freeze({
  additionalContext: frameUnavailableNotice(),
  block: false,
  hitCount: 0,
  isGap: false,
  unavailable: true,
});

/** Sentinel to distinguish a server error/unavailable (fail-open) from a genuine empty result. */
const FAILED = Symbol('FAILED');

export class RetrievalBroker {
  private readonly store: SessionShownStore;
  private readonly topics: SessionTopicStore;
  constructor(
    private readonly deps: BrokerDeps,
    store?: SessionShownStore,
    topicStore?: SessionTopicStore,
  ) {
    this.store = store ?? new SessionShownStore(deps.sessionId);
    this.topics = topicStore ?? new SessionTopicStore(deps.sessionId);
  }

  private minHits(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_MIN_HITS ?? '1', 10) || 1); }
  private limit(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_SEMANTIC_INJECT_LIMIT ?? '5', 10) || 5); }
  private timeoutMs(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_TIMEOUT_MS ?? '2000', 10) || 2000); }
  private mode(): EnforcementMode { return this.deps.settings.MEMSMITH_RETRIEVAL_ENFORCEMENT === 'hard' ? 'hard' : 'soft'; }

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
   * Shared decision logic. `allowBlock` gates blocking to PreToolUse only.
   *
   * AMENDMENT 1 (2026-08-11) — `block` keys on "has this TOPIC been consulted
   * this session", NOT on hit count. The reverted design blocked whenever memory
   * returned >= MIN_HITS results, so a rich corpus blocked nearly every command
   * and the agent could not work. Inverting the predicate makes blocks RARER as
   * memory grows: a good recall means the agent never reaches for the search at
   * all. Friction is bounded to one block per topic per session.
   *
   * Note this method does NOT call markConsulted. The broker's own /v1/context
   * query is not the agent consulting memory — the agent does that by calling an
   * ms-mem-search tool. Marking here would unlock the topic on the very call
   * being blocked, so marking belongs to the hook adapter.
   */
  private decide(hits: ProvenancedMemory[], allowBlock: boolean, topic: string): RetrievalResult {
    const hitCount = hits.length;
    const block = allowBlock
      && this.mode() === 'hard'
      && topic.length > 0
      && !this.topics.hasConsulted(topic);
    const blockFields = block
      ? {
          block: true as const,
          blockReason:
            'Consult MemSmith memory first — query the MemSmith memory tools '
            + '(observation_search / smart_search) for this topic, then re-run. '
            + 'Memory is the first source for why/decision questions; code is the '
            + 'verification pass.',
        }
      : { block: false as const };

    if (hitCount < this.minHits()) {
      // A real gap: memory WAS asked and had nothing recorded. Still block when
      // the topic is unconsulted — the agent must ask before falling to code.
      return { additionalContext: frameGapNote(), ...blockFields, hitCount, isGap: true, unavailable: false };
    }
    // Strong hit → dedup against session-shown, inject the fresh ones.
    const shown = this.store.readShown();
    const fresh = hits.filter(h => !shown.has(h.id));
    if (fresh.length === 0) {
      return { additionalContext: '', ...blockFields, hitCount, isGap: false, unavailable: false };
    }
    this.store.markShown(fresh.map(h => h.id));
    return { additionalContext: frameMemory(fresh), ...blockFields, hitCount, isGap: false, unavailable: false };
  }

  async forPrompt(promptText: string): Promise<RetrievalResult> {
    if (!promptText || promptText.trim().length === 0) return EMPTY;
    const hits = await this.query(promptText);
    if (hits === FAILED) return UNAVAILABLE; // fail-open, but visible (Amendment 2)
    // Prompt injection never blocks (blocking is a PreToolUse-only mechanism).
    return this.decide(hits, /* allowBlock */ false, topicKey(promptText));
  }

  async forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> {
    const q = deriveQueryFromTool(toolName, toolArgs, { warmPaths: this.deps.warmPaths });
    if (q === null) return EMPTY; // not a search-intent tool — nothing to enforce
    const hits = await this.query(q);
    if (hits === FAILED) return UNAVAILABLE; // fail-open, but visible (Amendment 2)
    return this.decide(hits, /* allowBlock */ true, topicKey(q));
  }
}
