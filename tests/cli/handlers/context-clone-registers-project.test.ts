// SPDX-License-Identifier: Apache-2.0
//
// A cloned project must be REGISTERED, not merely read.
//
// SessionStart resolved the dashboard link like this:
//
//   dashboardProjectId = readProjectMarker(cwd)?.projectId;
//   if (!dashboardProjectId) { await mintProjectIdentity(cwd); }
//
// which looks right — a marker means the project is already known. It is not.
// A CLONED project arrives with a committed marker and no rows anywhere,
// because nothing on this machine has ever run for it. So the marker was
// adopted and never registered: no `projects` row.
//
// That row is what /v1/identity needs to report a project's runtime (via
// projects.metadata → resolveProjectRuntime). Without it the dashboard could
// not tell the clone was a team project, so the Join button never appeared —
// on the one machine that needed it. Observed live: a session ran in a
// marker-bearing project and left zero rows behind.
//
// ensureProjectIdentity is idempotent and upserts teams/projects on every call
// ("a fresh DB / cloned repo self-heals"), so calling it unconditionally costs
// an existing project one upsert and gives a clone the row it needs.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  contextHandler,
  setContextDependenciesForTesting,
} from '../../../src/cli/handlers/context.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ms-clone-'));
  // A cloned team project: committed marker, nothing else.
  mkdirSync(join(cwd, '.memsmith'), { recursive: true });
  writeFileSync(
    join(cwd, '.memsmith', 'project.json'),
    JSON.stringify({
      teamId: 'team-abc', projectId: 'cloned-proj',
      runtime: 'server', serverUrl: 'https://example.invalid',
    }),
    'utf-8',
  );
});
afterEach(() => {
  setContextDependenciesForTesting({});
  rmSync(cwd, { recursive: true, force: true });
});

/** Base deps that keep the handler off the network and off the real DB. */
function deps(mint: (c: string) => Promise<{ teamId: string; projectId: string } | null>) {
  return {
    mintProjectIdentity: mint,
    loadFromFileOnce: () => ({}),
    getProjectContext: () => ({
      primary: 'cloned', parent: null, isWorktree: false, allProjects: ['cloned'],
    }),
    resolveRuntimeContext: () => ({
      runtime: 'local' as const, reason: 'server_context_unavailable' as const,
    }),
  };
}

describe('SessionStart in a cloned project', () => {
  it('REGISTERS the identity even though a marker already exists', async () => {
    // The regression. Previously the marker short-circuited the mint, so the
    // project was never inserted and the dashboard could not classify it.
    const calls: string[] = [];
    setContextDependenciesForTesting(deps(async (c) => {
      calls.push(c);
      return { teamId: 'team-abc', projectId: 'cloned-proj' };
    }) as never);

    await contextHandler.execute({
      sessionId: 's-clone', cwd, platform: 'claude', hookEvent: 'SessionStart',
    } as never);

    expect(calls).toEqual([cwd]);
  });

  it('still emits a dashboard link scoped to the marker when registration fails', async () => {
    // Registration needs a reachable Postgres; a failure must not cost the user
    // their scoped link, because the marker already names the project.
    setContextDependenciesForTesting(deps(async () => null) as never);

    const result = await contextHandler.execute({
      sessionId: 's-clone-fail', cwd, platform: 'claude', hookEvent: 'SessionStart',
    } as never);

    const text = JSON.stringify(result);
    expect(text).toContain('cloned-proj');
  });

  it('never throws when registration rejects', async () => {
    // This runs on the SessionStart hot path. Breaking the session to record a
    // project row would be a far worse trade than a missing row.
    setContextDependenciesForTesting(deps(async () => {
      throw new Error('postgres unreachable');
    }) as never);

    const result = await contextHandler.execute({
      sessionId: 's-clone-throw', cwd, platform: 'claude', hookEvent: 'SessionStart',
    } as never);

    expect(result).toBeDefined();
  });
});
