// tests/scripts/backfill-attribution.test.ts
import { describe, it, expect } from 'bun:test';
import { buildCountSql, buildUpdateSql, parseConfig } from '../../scripts/backfill-attribution.mjs';

describe('backfill-attribution config + SQL', () => {
  it('requires OWNER_USER_ID and TEAM_ID', () => {
    expect(() => parseConfig({ TEAM_ID: 't' }, [])).toThrow(/OWNER_USER_ID/);
    expect(() => parseConfig({ OWNER_USER_ID: 'o' }, [])).toThrow(/TEAM_ID/);
  });
  it('defaults to dry-run; --execute flips it', () => {
    expect(parseConfig({ OWNER_USER_ID: 'o', TEAM_ID: 't' }, []).execute).toBe(false);
    expect(parseConfig({ OWNER_USER_ID: 'o', TEAM_ID: 't' }, ['--execute']).execute).toBe(true);
  });
  it('count SQL scopes to team; adds project clause only when PROJECT_ID set', () => {
    const teamOnly = buildCountSql(false);
    expect(teamOnly).toMatch(/team_id = \$1/);
    expect(teamOnly).not.toMatch(/project_id/);
    const withProj = buildCountSql(true);
    expect(withProj).toMatch(/project_id = \$2/);
  });
  it("update SQL only touches null-owner rows and never overwrites an existing owner", () => {
    const sql = buildUpdateSql(false);
    expect(sql).toMatch(/metadata->>'createdByUserId' IS NULL/);
    expect(sql).toMatch(/jsonb_set/);
    expect(sql).not.toMatch(/DELETE/i);
  });
});
