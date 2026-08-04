// SPDX-License-Identifier: Apache-2.0
//
// Rate limiting for POST /v1/join/register, which is deliberately
// UNAUTHENTICATED (see the spec's §2.1): the team key travels in the body
// rather than the Authorization header, so that the four specific rejection
// reasons — unknown / revoked / expired / teamless — survive. A flat 401 from
// the auth middleware would collapse all four.
//
// That choice makes the route reachable without prior authentication, so it
// needs its own limit. The existing requireRateLimit CANNOT be reused as-is:
//
//   rate-limit.ts:54-55
//     const subject = req.authContext?.apiKeyId;
//     if (!subject) return next();   // unauthenticated bypass
//
// On an unauthenticated route authContext is undefined, so wiring that limiter
// in would look correct and enforce NOTHING. Only the subject derivation is new
// — the storage layer is reused unchanged, because rate_limit_counters.subject_id
// is TEXT with no foreign key (schema.ts:287-291), so an arbitrary subject
// string is already legal.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresRateLimitRepository } from '../../storage/postgres/rate-limit.js';
import { logger } from '../../utils/logger.js';

/**
 * The bucket this request counts against.
 *
 * Two buckets, deliberately:
 *  - `joinkey:<hash>` when a key is supplied. One team's legitimate retries
 *    cannot exhaust another team's budget, and one noisy teammate cannot lock
 *    out colleagues behind the same NAT.
 *  - `joinip:<ip>` otherwise. This is the branch that actually resists guessing:
 *    an attacker probing for valid keys produces many DISTINCT hashes from a
 *    single source, so per-key buckets would never fill.
 *
 * Only the HASH is used, never the raw key: the subject is persisted to
 * rate_limit_counters.subject_id.
 */
export function joinRateLimitSubject(
  body: unknown,
  clientIp: string,
  hashKey: (raw: string) => string,
): string {
  const raw = (body && typeof body === 'object')
    ? (body as { teamKey?: unknown }).teamKey
    : undefined;
  // Guard the type explicitly: the body is attacker-controlled JSON, so
  // { teamKey: {} } must never reach hashKey.
  if (typeof raw === 'string' && raw.trim()) return `joinkey:${hashKey(raw.trim())}`;
  // Never return an empty subject — subject_id is NOT NULL, and an empty string
  // would silently merge unrelated callers into a single shared bucket.
  return `joinip:${clientIp || 'unknown'}`;
}

/**
 * Fixed-window limiter for the unauthenticated join-register route.
 *
 * FAILS OPEN, matching rate-limit.ts:58-63 ("a limiter/quota storage hiccup must
 * never take the API down"). That is a deliberate choice here rather than an
 * inherited one: fail-open is the wrong default for most anti-guessing controls,
 * but a database blip must not make joining impossible, and the resistance given
 * up is marginal against a SHA-256 key space.
 */
export function requireJoinRateLimit(
  pool: PostgresPool,
  opts: { windowSec: number; max: number },
  hashKey: (raw: string) => string,
): RequestHandler {
  const repo = new PostgresRateLimitRepository(pool);
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const subject = joinRateLimitSubject(req.body, clientIp, hashKey);
    const ms = opts.windowSec * 1000;
    const windowStart = new Date(Math.floor(Date.now() / ms) * ms);
    const resetMs = windowStart.getTime() + ms;
    try {
      const result = await repo.hit({ subjectId: subject, windowStart, limit: opts.max });
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - result.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))));
        // Same body shape as the existing limiter (rate-limit.ts:42-45) so
        // clients need no special case for this route.
        res.status(429).json({
          error: 'rate_limited',
          message: `Rate limit exceeded (${opts.max} requests / ${opts.windowSec}s)`,
        });
        return;
      }
      next();
    } catch (error) {
      logger.warn('HTTP', 'join rate limit check failed; allowing request (fail open)', {
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}
