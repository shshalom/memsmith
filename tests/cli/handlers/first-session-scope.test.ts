// SPDX-License-Identifier: Apache-2.0
//
// THE BUG: on the FIRST session of a brand-new project, the dashboard link
// printed at session start was always unscoped — a bare
// http://127.0.0.1:38879 with no ?project=.
//
// Cause was an ordering gap between two different Claude Code events:
//   SessionStart      -> contextHandler prints the dashboard link
//   UserPromptSubmit  -> sessionInitHandler mints the project identity
//
// So on session 1 the link is printed BEFORE anything has minted, the marker
// does not exist, and context.ts falls back to the unscoped URL. Only session 2
// (after a prompt has been sent) shows the right link. context.ts treated a
// missing marker as an edge case — "an unreadable marker just yields the
// unscoped link" — but on a fresh project it is the CERTAIN case.
//
// Why it matters beyond cosmetics: one server serves every local project, so an
// unscoped link lands on whichever project the SERVER booted from. On a fresh
// install that is a link straight into a different project's memory, and the Go
// Team wizard opened from there would act on that other project.
//
// THE FIX: ensureProjectIdentityForHook is a shared, idempotent mint that both
// handlers call, so identity exists before the link is composed. Extracted rather
// than copied — session-init's block carries load-bearing knowledge (the
// MEMSMITH_SERVER_DATABASE_URL derivation that a short-lived hook process never
// inherits) that must not fork.
import { describe, it, expect } from 'bun:test';
import { resolveDashboardUrl } from '../../../src/shared/dashboard-url.js';

describe('resolveDashboardUrl scoping contract', () => {
  it('scopes the link when a projectId is known', () => {
    const url = resolveDashboardUrl('c59d8bce-3c0a-43a3-acc3-286a2cdabb2f');
    expect(url).toContain('?project=c59d8bce-3c0a-43a3-acc3-286a2cdabb2f');
  });

  it('falls back to an unscoped link when no projectId is known', () => {
    // Still the correct fallback — the fix is to make sure a fresh project HAS
    // an id by this point, not to change what happens when it genuinely has none.
    expect(resolveDashboardUrl(undefined)).not.toContain('?project=');
    expect(resolveDashboardUrl('')).not.toContain('?project=');
    expect(resolveDashboardUrl('   ')).not.toContain('?project=');
  });

  it('url-encodes the project id', () => {
    expect(resolveDashboardUrl('a b&c')).toContain('?project=a%20b%26c');
  });
});

// The mint helper both handlers share. Dependency-injected so the contract can be
// pinned without a live Postgres.
import { ensureProjectIdentityForHook } from '../../../src/cli/handlers/ensure-identity.js';

describe('ensureProjectIdentityForHook', () => {
  function deps(over: Partial<Parameters<typeof ensureProjectIdentityForHook>[1]> = {}) {
    const calls: string[] = [];
    return {
      calls,
      base: {
        resolveLocalBaseDatabaseUrl: () => { calls.push('dsn'); return 'postgres://local/base'; },
        getPool: () => { calls.push('pool'); return {} as never; },
        ensureProjectIdentity: async () => {
          calls.push('mint');
          return { teamId: 'team-x', projectId: 'proj-x' };
        },
        ...over,
      },
    };
  }

  it('returns the minted identity so the caller can scope the dashboard link', async () => {
    const d = deps();
    const ids = await ensureProjectIdentityForHook('/proj/a', d.base as never);
    expect(ids).toEqual({ teamId: 'team-x', projectId: 'proj-x' });
  });

  it('derives the base DSN before building the pool', async () => {
    // Load-bearing: a short-lived hook process never inherits
    // MEMSMITH_SERVER_DATABASE_URL from the server, so the pool would throw and
    // minting would be skipped forever on a fresh project.
    const d = deps();
    await ensureProjectIdentityForHook('/proj/a', d.base as never);
    expect(d.calls.indexOf('dsn')).toBeLessThan(d.calls.indexOf('pool'));
    expect(d.calls).toContain('mint');
  });

  it('returns null instead of throwing when minting fails', async () => {
    // This runs on the session-start path. A mint failure must degrade to an
    // unscoped link, never break the session.
    const ids = await ensureProjectIdentityForHook('/proj/a', {
      resolveLocalBaseDatabaseUrl: () => 'postgres://local/base',
      getPool: () => ({} as never),
      ensureProjectIdentity: async () => { throw new Error('pg down'); },
    } as never);
    expect(ids).toBeNull();
  });

  it('returns null when the DSN cannot be resolved', async () => {
    const ids = await ensureProjectIdentityForHook('/proj/a', {
      resolveLocalBaseDatabaseUrl: () => { throw new Error('no dsn'); },
      getPool: () => ({} as never),
      ensureProjectIdentity: async () => ({ teamId: 't', projectId: 'p' }),
    } as never);
    expect(ids).toBeNull();
  });

  it('does not mint for an empty cwd', async () => {
    const d = deps();
    const ids = await ensureProjectIdentityForHook('', d.base as never);
    expect(ids).toBeNull();
    expect(d.calls).not.toContain('mint');
  });
});
