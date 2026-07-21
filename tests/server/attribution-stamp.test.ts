import { describe, it, expect } from 'bun:test';
import { stampAttribution } from '../../src/server/routes/v1/attribution';

describe('stampAttribution', () => {
  it('adds createdByUserId when a user is present', () => {
    expect(stampAttribution({ a: 1 }, { userId: 'u1' } as any)).toEqual({ a: 1, createdByUserId: 'u1' });
  });
  it('leaves metadata unchanged when userId is null (legacy key)', () => {
    expect(stampAttribution({ a: 1 }, { userId: null } as any)).toEqual({ a: 1 });
  });
});
