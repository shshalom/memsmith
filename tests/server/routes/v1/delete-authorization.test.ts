import { describe, it, expect } from 'bun:test';
import { authorizeObservationDelete } from '../../../../src/server/routes/v1/delete-authorization.js';

const note = (owner: string | null) => ({ kind: 'user_note', createdByUserId: owner });
const obs = (owner: string | null) => ({ kind: 'observation', createdByUserId: owner });

describe('authorizeObservationDelete', () => {
  it('member may delete own user_note', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note('u1'))).toEqual({ allow: true });
  });
  it("member may NOT delete another member's note (wrong_owner)", () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note('u2'))).toEqual({ allow: false, reason: 'wrong_owner' });
  });
  it('member may NOT delete a null-owner note (wrong_owner)', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note(null))).toEqual({ allow: false, reason: 'wrong_owner' });
  });
  it('member may NOT delete a generated observation (wrong_kind)', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, obs('u1'))).toEqual({ allow: false, reason: 'wrong_kind' });
  });
  it('admin may delete any kind / any owner', () => {
    expect(authorizeObservationDelete({ role: 'admin', userId: 'a1' }, note('u2'))).toEqual({ allow: true });
    expect(authorizeObservationDelete({ role: 'admin', userId: 'a1' }, obs('u2'))).toEqual({ allow: true });
  });
  it('owner may delete any kind / any owner', () => {
    expect(authorizeObservationDelete({ role: 'owner', userId: 'o1' }, obs('u2'))).toEqual({ allow: true });
  });
  it('null role (legacy scope-only key) may delete anything (back-compat)', () => {
    expect(authorizeObservationDelete({ role: null, userId: null }, obs(null))).toEqual({ allow: true });
    expect(authorizeObservationDelete({ role: null, userId: null }, note('u2'))).toEqual({ allow: true });
  });
});
