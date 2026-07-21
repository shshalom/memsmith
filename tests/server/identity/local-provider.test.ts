import { describe, it, expect } from 'bun:test';
import { localProvider, LOCAL_OWNER_USER_ID } from '../../../src/server/identity/providers/local-provider';

describe('localProvider', () => {
  it("id is 'local'", () => { expect(localProvider.id).toBe('local'); });
  it('resolves the stable implicit owner', async () => {
    const r = await localProvider.authenticate({} as any);
    expect(r).toEqual({ userId: LOCAL_OWNER_USER_ID });
  });
  it('exports a stable owner id', () => { expect(LOCAL_OWNER_USER_ID).toBe('local-owner'); });
});
