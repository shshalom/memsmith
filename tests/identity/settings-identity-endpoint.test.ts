import { describe, it, expect } from 'bun:test';
import { maskKey, buildIdentityPayload } from '../../src/server/routes/v1/identity-payload.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('identity payload', () => {
  it('maskKey shows only the last 4 chars', () => {
    expect(maskKey('msk_abcdefgh1234')).toBe('msk_••••••••1234');
    expect(maskKey('')).toBe('');
  });

  it('buildIdentityPayload reports keyPresent + masked, never plaintext unless revealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-idp-'));
    const store = new CredentialStore(join(dir, 'c.json'));
    store.storeKeyForTeam('team-z', 'msk_secretzz1234');
    const payload = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: false });
    expect(payload.teamId).toBe('team-z');
    expect(payload.projectId).toBe('proj-z');
    expect(payload.keyPresent).toBe(true);
    expect(payload.keyMasked).toBe('msk_••••••••1234');
    expect((payload as any).keyPlaintext).toBeUndefined();
    const revealed = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: true });
    expect(revealed.keyPlaintext).toBe('msk_secretzz1234');
    rmSync(dir, { recursive: true, force: true });
  });
});
