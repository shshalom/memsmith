// src/services/retrieval/broker.ts
import { SessionShownStore } from './session-store.js';
import { deriveQueryFromTool } from './query-derivation.js';
import { frameMemory, frameGapNote } from './directive.js';
import type { BrokerDeps, EnforcementMode, ProvenancedMemory, RetrievalResult } from './types.js';
import { logger } from '../../utils/logger.js';

const EMPTY: RetrievalResult = Object.freeze({ additionalContext: '', block: false, hitCount: 0, isGap: false });

/** Sentinel to distinguish a server error/unavailable (fail-open) from a genuine empty result. */
const FAILED = Symbol('FAILED');

export class RetrievalBroker {
  private readonly store: SessionShownStore;
  constructor(private readonly deps: BrokerDeps, store?: SessionShownStore) {
    this.store = store ?? new SessionShownStore(deps.sessionId);
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

  /** Shared decision logic. `allowBlock` gates hard-mode blocking to PreToolUse only. */
  private decide(hits: ProvenancedMemory[], allowBlock: boolean): RetrievalResult {
    const minHits = this.minHits();
    const hitCount = hits.length;
    if (hitCount < minHits) {
      // Miss → gap-flag, never block.
      return { additionalContext: frameGapNote(), block: false, hitCount, isGap: true };
    }
    // Strong hit → dedup against session-shown, inject the fresh ones.
    const shown = this.store.readShown();
    const fresh = hits.filter(h => !shown.has(h.id));
    if (fresh.length === 0) {
      return { additionalContext: '', block: false, hitCount, isGap: false };
    }
    this.store.markShown(fresh.map(h => h.id));
    const context = frameMemory(fresh);
    const block = allowBlock && this.mode() === 'hard';
    return {
      additionalContext: context,
      block,
      ...(block ? { blockReason: 'Consult MemSmith memory first — relevant recorded context exists. Query ms-mem-search, then re-run.' } : {}),
      hitCount,
      isGap: false,
    };
  }

  async forPrompt(promptText: string): Promise<RetrievalResult> {
    if (!promptText || promptText.trim().length === 0) return EMPTY;
    const hits = await this.query(promptText);
    if (hits === FAILED) return EMPTY; // fail-open: server error or unavailable runtime
    // Prompt injection never blocks (blocking is a PreToolUse-only mechanism).
    return this.decide(hits, /* allowBlock */ false);
  }

  async forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> {
    const q = deriveQueryFromTool(toolName, toolArgs);
    if (q === null) return EMPTY; // not a search-intent tool
    const hits = await this.query(q);
    if (hits === FAILED) return EMPTY; // fail-open: server error or unavailable runtime
    return this.decide(hits, /* allowBlock */ true);
  }
}
