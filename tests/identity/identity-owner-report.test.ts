// SPDX-License-Identifier: Apache-2.0
//
// The Go Team wizard needs to know whether a real owner identity already exists
// before it decides to show a Sign-In card. It must NOT ask the machine's owner
// to log in when there is nobody else to be — and it must not guess.
//
// GET /v1/identity is the natural source: the auth middleware has already
// resolved role into req.authContext (postgres-auth.ts:274 for api-key mode,
// :190 for the loopback local-dev owner), so reporting it costs no extra query.
//
// The load-bearing safety property is the fail-safe direction: absent or
// non-owner role must report ownerEstablished:false, so an unknown state keeps
// the sign-in step rather than silently skipping it.
import { describe, it, expect } from 'bun:test';
import { buildIdentityPayload } from '../../src/server/routes/v1/identity-payload.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function storeIn(dir: string): CredentialStore {
  const store = new CredentialStore(join(dir, 'creds.json'));
  store.storeKeyForTeam('team-o', 'msk_ownerkey00001234');
  return store;
}

describe('identity payload reports whether an owner is established', () => {
  it('reports ownerEstablished true for an owner role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-owner-'));
    try {
      const payload = buildIdentityPayload(
        { teamId: 'team-o', projectId: 'proj-o' },
        storeIn(dir),
        { reveal: false, role: 'owner' },
      );
      expect(payload.ownerEstablished).toBe(true);
      expect(payload.role).toBe('owner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports ownerEstablished false for a non-owner role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-owner-'));
    try {
      for (const role of ['admin', 'member'] as const) {
        const payload = buildIdentityPayload(
          { teamId: 'team-o', projectId: 'proj-o' },
          storeIn(dir),
          { reveal: false, role },
        );
        expect(payload.ownerEstablished).toBe(false);
        expect(payload.role).toBe(role);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails safe to false when the role is null or absent', () => {
    // A null role is exactly what a better-auth session produces today
    // (postgres-auth.ts:244 hardcodes role:null). It must NOT be read as
    // ownership — that would let a session with no team skip the owner step.
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-owner-'));
    try {
      const nullRole = buildIdentityPayload(
        { teamId: 'team-o', projectId: 'proj-o' },
        storeIn(dir),
        { reveal: false, role: null },
      );
      expect(nullRole.ownerEstablished).toBe(false);
      expect(nullRole.role).toBeNull();

      const absent = buildIdentityPayload(
        { teamId: 'team-o', projectId: 'proj-o' },
        storeIn(dir),
        { reveal: false },
      );
      expect(absent.ownerEstablished).toBe(false);
      expect(absent.role).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not disturb the existing payload fields', () => {
    // Regression guard: the key-masking contract is security-relevant and must
    // be untouched by this addition.
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-owner-'));
    try {
      const payload = buildIdentityPayload(
        { teamId: 'team-o', projectId: 'proj-o' },
        storeIn(dir),
        { reveal: false, role: 'owner' },
      );
      expect(payload.teamId).toBe('team-o');
      expect(payload.projectId).toBe('proj-o');
      expect(payload.keyPresent).toBe(true);
      expect(payload.keyMasked).toBe('msk_••••••••1234');
      expect((payload as any).keyPlaintext).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still never leaks plaintext unless revealed, with a role present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-owner-'));
    try {
      const revealed = buildIdentityPayload(
        { teamId: 'team-o', projectId: 'proj-o' },
        storeIn(dir),
        { reveal: true, role: 'owner' },
      );
      expect(revealed.keyPlaintext).toBe('msk_ownerkey00001234');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
