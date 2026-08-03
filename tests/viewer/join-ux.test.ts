// SPDX-License-Identifier: Apache-2.0
//
// Joining a team must be reachable from the dashboard, and the instructions must
// name something that exists.
//
// The wizard's final step told teammates to run
// `memsmith join --key <k> --url <u>`. That command is not in the CLI — the real
// list is adopt, antigravity-cli, cleanup, doctor, install, remove, repair,
// restart, search, server, start, status, stop, telemetry, transcript,
// uninstall, update, upgrade, version, worker. So every teammate following the
// wizard hit "unknown command" and the join flow was a dead end that nothing
// tested, because no test compared the instructions against the command list.
//
// That comparison is the guard below: docs that name a command are checked
// against the commands that exist.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

/** Commands the CLI actually dispatches. */
function cliCommands(): Set<string> {
  const src = read('src/npx-cli/index.ts');
  return new Set(Array.from(src.matchAll(/case '([a-z-]+)'/g), m => m[1]!));
}

describe('the invite instructions name commands that exist', () => {
  it('does NOT tell teammates to run a nonexistent `memsmith join`', () => {
    const commands = cliCommands();
    // Strip comments first: the code comment here deliberately quotes the dead
    // command to explain why it was removed, and a naive scan flags that as the
    // very thing it is warning about. Only what the USER sees is checked.
    const invite = read('src/ui/viewer/views/wizard/cards/InviteCard.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // The specific regression: the step existed for as long as the wizard did.
    const mentions = Array.from(invite.matchAll(/memsmith\s+([a-z-]+)/g), m => m[1]!);
    for (const cmd of mentions) {
      expect({ cmd, exists: commands.has(cmd) }).toEqual({ cmd, exists: true });
    }
  });

  it('points teammates at the dashboard instead', () => {
    const invite = read('src/ui/viewer/views/wizard/cards/InviteCard.tsx');
    expect(invite).toMatch(/dashboard/i);
    expect(invite).toMatch(/Join/);
  });
});

describe('Join is offered on the Runtime tile', () => {
  const dash = read('src/ui/viewer/views/DashboardView.tsx');

  it('renders a Join action on the Runtime tile', () => {
    expect(dash).toContain('dash-kpi-action');
    expect(dash).toMatch(/k\.l === 'Runtime'/);
  });

  it('gates the action through canJoinFromIdentity, not a runtime literal', () => {
    // This case previously asserted `canJoin = runtime === 'local'`, and that
    // assertion encoded an assumption of mine that was exactly backwards:
    //
    //   LOCAL -> no team exists yet, so there is nothing to join. The local
    //            route to a team is GO TEAM (convert), in Settings.
    //   TEAM  -> a workspace exists and a NEW MEMBER can join it; the OWNER is
    //            already in by construction.
    //
    // So the old gating showed the button where there was nothing to join and
    // hid it where joining is the point. The WHEN now lives in
    // canJoinFromIdentity, covered directly by join-button-team-mode.test.ts;
    // this file keeps asserting WHERE it renders.
    expect(dash).not.toMatch(/canJoin\s*=\s*runtime === 'local'/);
    expect(dash).toContain('canJoinFromIdentity');
  });

  it('mounts the join modal', () => {
    expect(dash).toContain('JoinTeamModal');
  });

  it('reloads after joining rather than patching state', () => {
    // Joining changes the runtime, the credential, and every scoped read on the
    // page at once; a partial refresh would leave panels disagreeing.
    expect(dash).toMatch(/onJoined=\{\(\) => location\.reload\(\)\}/);
  });
});

describe('the join modal', () => {
  const modal = read('src/ui/viewer/components/JoinTeamModal.tsx');

  it('sends the project cookie', () => {
    // /v1/join is scope-gated; without credentials it 401s and the user sees a
    // meaningless failure.
    expect(modal).toContain("credentials: 'include'");
  });

  it('masks the team key as it is typed', () => {
    // It is a full-access credential and the dashboard is often on a shared
    // screen.
    expect(modal).toMatch(/type="password"/);
  });

  it('surfaces the server\'s reason verbatim', () => {
    // The server distinguishes unreachable / invalid / revoked / expired /
    // teamless. Collapsing those into "join failed" throws away the only
    // information that tells the user what to do.
    expect(modal).toMatch(/body\.error/);
  });

  it('requires both fields before enabling submit', () => {
    expect(modal).toMatch(/databaseUrl\.trim\(\)\.length > 0 && apiKey\.trim\(\)\.length > 0/);
  });
});

describe('the /v1/join route', () => {
  const routes = read('src/server/routes/v1/ConvertRoutes.ts');

  it('exists', () => {
    expect(routes).toMatch(/'\/v1\/join'/);
  });

  it('is NOT owner-gated', () => {
    // Convert requires owner because it moves the owner's data. Join is what a
    // NON-owner does — requiring owner would mean only the person who already
    // has the workspace could join it.
    expect(routes).toMatch(/joinAuthMiddleware/);
  });

  it('takes the project from authContext, never the body', () => {
    // Same rule as convert: the caller must not be able to name someone else's
    // project.
    expect(routes).toMatch(/req\.authContext\?\.projectId/);
  });

  it('answers 422 on a rejected invite, not 500', () => {
    // A wrong key is user-correctable input, not a server fault.
    expect(routes).toMatch(/'joined' \? 200 : 422/);
  });
});
