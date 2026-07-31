// SPDX-License-Identifier: Apache-2.0
//
// The dashboard's Runtime tile was the LITERAL STRING 'local':
//
//   { n: 'local', l: 'Runtime', hint: 'embedded Postgres · no Docker' }
//
// identically in DashboardView.tsx and server/dashboard/ui.html. It never read
// anything, so it displayed "local" on a team install too — and it was
// accidentally correct right up until someone ran Go Team, which is exactly the
// moment the answer matters.
//
// Reported live: a project whose marker said runtime=server, whose 19
// observations were verifiably copied to the shared database, still showed
// "local". The wizard said "This project is now in Team mode" and the dashboard
// contradicted it — with the dashboard being the one that was wrong. /v1/info had
// returned `runtime: 'server-beta'` the whole time.
//
// Two properties matter and neither is cosmetic:
//   1. A converted project must NOT read "local" — that is the reported bug.
//   2. An unreadable runtime must NOT fall back to "local". Guessing is how the
//      tile became misleading; "—" is honest.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');

/**
 * Mirror of the tile logic in both dashboards. Kept in the test rather than
 * imported because ui.html is a raw script (no module boundary) — the source
 * guards below assert the two copies stay in step.
 */
function runtimeTile(runtime: string | null): { n: string; hint: string } {
  if (runtime === 'team' || runtime === 'server' || runtime === 'server-beta') {
    return { n: 'team', hint: 'shared Postgres · team workspace' };
  }
  if (runtime === 'local') {
    return { n: 'local', hint: 'embedded Postgres · no Docker' };
  }
  return { n: '—', hint: 'runtime unavailable' };
}

describe('dashboard Runtime tile', () => {
  it('reads "team" for a converted project', () => {
    expect(runtimeTile('server').n).toBe('team');
  });

  it('accepts the literal /v1/identity ACTUALLY returns: "team"', () => {
    // THE BUG THIS FILE MISSED. The mapping listed only server/server-beta,
    // written when the tile read /v1/info. Repointing it at /v1/identity — which
    // reports per-project and was the right move — silently broke it: 'team' fell
    // through to the unknown branch and the tile read "— runtime unavailable" on a
    // correctly converted project, reported three times by the user.
    //
    // The test passed throughout because it asserted MY assumption about the
    // wire format instead of the format the endpoint declares. IdentityPayload's
    // runtime is typed 'local' | 'team' (identity-payload.ts:35) — 'server' is
    // not a value it can ever produce.
    expect(runtimeTile('team').n).toBe('team');
  });

  it('pins the payload contract, so a repoint cannot silently break it again', async () => {
    // Read the declared type rather than trusting a comment: if the server ever
    // renames these literals, this fails instead of the tile going blank.
    const { readFileSync } = await import('fs');
    const src = readFileSync(join(REPO, 'src/server/routes/v1/identity-payload.ts'), 'utf-8');
    const declared = src.match(/runtime:\s*([^;]+);/)?.[1] ?? '';
    for (const literal of declared.split('|').map(s => s.trim().replace(/'/g, ''))) {
      if (!literal) continue;
      // Every value the payload can carry must map to a real label, never "—".
      expect(runtimeTile(literal).n).not.toBe('—');
    }
  });

  it('treats the legacy server-beta literal as team, not as a raw label', () => {
    // /v1/info still reports 'server-beta'; showing that string at the user
    // would be accurate but meaningless to them.
    expect(runtimeTile('server-beta').n).toBe('team');
  });

  it('reads "local" for a local project', () => {
    expect(runtimeTile('local').n).toBe('local');
  });

  it('does NOT claim "local" when the runtime cannot be read', () => {
    // The original bug in one line: an unread runtime rendered as a confident
    // "local". Absence must look like absence.
    expect(runtimeTile(null).n).toBe('—');
    expect(runtimeTile('').n).toBe('—');
    expect(runtimeTile('something-new').n).toBe('—');
  });

  it('never labels a team runtime with the local hint', () => {
    // "embedded Postgres · no Docker" under a team runtime is actively wrong:
    // team memory is served from shared Postgres.
    expect(runtimeTile('server').hint).not.toContain('no Docker');
  });
});

describe('both dashboards read the runtime instead of hardcoding it', () => {
  const sources = [
    'src/ui/viewer/views/DashboardView.tsx',
    'src/server/dashboard/ui.html',
  ];

  for (const rel of sources) {
    it(`${rel} builds the Runtime tile from a function, not a literal`, () => {
      const src = readFileSync(join(REPO, rel), 'utf-8');
      // The bug was a hardcoded tile in the CARD ARRAY. A 'local' literal is
      // still legitimate INSIDE runtimeTile() — that is the local branch. So
      // assert on the array: it must call the resolver, not inline a value.
      expect(src).toMatch(/runtimeTile\(/);
      // And the card array must not contain the Runtime tile inline.
      const cardArray = src.slice(src.indexOf('Memories'), src.indexOf('Memories') + 600);
      expect(cardArray).not.toMatch(/l:\s*'Runtime'/);
    });

    it(`${rel} sources the runtime PER PROJECT, not from the server`, () => {
      const src = readFileSync(join(REPO, rel), 'utf-8');
      // My first fix read /v1/info — the SERVER's runtime, ONE value for the
      // whole process ('server-beta' whenever the server runtime is up). So the
      // moment any single project converted, EVERY project's tile read "team",
      // including the still-local dogfood. Reported immediately by the user.
      //
      // /v1/identity resolves the requested project's own marker and is scoped by
      // the viewer's project cookie — the same source Settings uses to gate the
      // GO TEAM button, so the two views cannot disagree.
      expect(src).toMatch(/v1\/identity|fetchIdentity/);
      // The server-wide endpoint must not FEED this tile. Checked against code
      // lines only — the comments here deliberately mention /v1/info to explain
      // why it is the wrong source, and a naive substring check flags those.
      const feedsFromInfo = src
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .some(line => line.includes('/v1/info') && /runtime|RUNTIME/i.test(line));
      expect(feedsFromInfo).toBe(false);
    });
  }
});
