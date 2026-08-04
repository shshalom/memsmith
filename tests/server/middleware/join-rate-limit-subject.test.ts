// SPDX-License-Identifier: Apache-2.0
//
// The join-register route is deliberately unauthenticated (spec §2.1), so the
// existing requireRateLimit — which reads req.authContext?.apiKeyId and calls
// next() when it is absent — would be a SILENT NO-OP there. These tests pin the
// subject derivation that replaces it.
import { describe, it, expect } from 'bun:test';
import { joinRateLimitSubject } from '../../../src/server/middleware/join-rate-limit-subject.js';

// A stand-in for sha256: deterministic, and — like a real hash — it does NOT
// embed its input. An `H(${raw})` style mock would make the "never returns the
// raw key" test below unsatisfiable by construction rather than testing anything.
const hash = (raw: string) => `h${[...raw].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;

describe('joinRateLimitSubject', () => {
  it('buckets by the key hash when a team key is present', () => {
    // Keying on the key hash keeps one noisy teammate from locking out
    // colleagues behind the same NAT.
    expect(joinRateLimitSubject({ teamKey: 'k1' }, '203.0.113.9', hash))
      .toBe(`joinkey:${hash('k1')}`);
  });

  it('falls back to the client IP when no key is supplied', () => {
    // The IP bucket is the branch that actually catches guessing: an attacker
    // probing for valid keys produces many DISTINCT hashes from one source.
    expect(joinRateLimitSubject({}, '203.0.113.9', hash)).toBe('joinip:203.0.113.9');
  });

  it('never hashes a non-string key', () => {
    // A JSON body is attacker-controlled; { teamKey: { } } must not reach hashKey.
    expect(joinRateLimitSubject({ teamKey: { evil: true } }, '203.0.113.9', hash))
      .toBe('joinip:203.0.113.9');
  });

  it('treats a blank key as absent', () => {
    expect(joinRateLimitSubject({ teamKey: '   ' }, '203.0.113.9', hash))
      .toBe('joinip:203.0.113.9');
  });

  it('never returns the raw key, only its hash', () => {
    // The subject is written to rate_limit_counters.subject_id, i.e. persisted.
    const subject = joinRateLimitSubject({ teamKey: 'super-secret' }, '', hash);
    expect(subject).not.toContain('super-secret');
  });

  it('produces a stable subject for the same key', () => {
    const a = joinRateLimitSubject({ teamKey: 'k1' }, '1.1.1.1', hash);
    const b = joinRateLimitSubject({ teamKey: 'k1' }, '2.2.2.2', hash);
    expect(a).toBe(b);
  });

  it('handles a null or non-object body without throwing', () => {
    expect(joinRateLimitSubject(null, '1.1.1.1', hash)).toBe('joinip:1.1.1.1');
    expect(joinRateLimitSubject('nope', '1.1.1.1', hash)).toBe('joinip:1.1.1.1');
  });

  it('uses a stable placeholder when both key and IP are missing', () => {
    // Must never return an empty subject: subject_id is NOT NULL and an empty
    // string would silently merge unrelated callers into one bucket.
    expect(joinRateLimitSubject({}, '', hash)).toBe('joinip:unknown');
  });
});
