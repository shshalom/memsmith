// SPDX-License-Identifier: Apache-2.0
//
// Tell the user, at SessionStart, that this project belongs to a team they
// have not joined.
//
// INSTALL-AGNOSTIC BY DESIGN. The first version of this lived in
// `npx memsmith install`. Real users install through Claude Code's `/plugin`,
// which never calls that CLI — so the code never ran and the teammate saw
// nothing. Recognition had been attached to the installer instead of to the
// project.
//
// Installing happens once, often in a different directory. OPENING THE PROJECT
// is what reveals which project you are in, happens every session, and is
// identical across `/plugin`, `npx memsmith install`, and anything added later.
// So the notice belongs here, on the SessionStart path that already reads the
// marker to build the dashboard link.
//
// Shares `projectJoinState` with the installer's notice, so the two surfaces
// cannot disagree about whether a project is tracked — the same requirement
// that motivated this move ("match behaviours regardless how the user is
// choosing to install memsmith").
//
// SILENT unless there is something to act on: no banner for a local project
// (there is no team) and none for a joined one (the user is already in, and the
// runtime tile shows it). Printing on every session of every project would be
// noise, and noise is how a real warning gets ignored.

import type { JoinState } from '../../services/identity/join-state.js';

export interface TrackedProjectBannerInput {
  state: JoinState;
  marker: { teamId: string; projectId: string; runtime?: string; serverUrl?: string } | null;
}

/**
 * One short block for the session banner, or '' when there is nothing to say.
 *
 * Terser than the installer's panel — this competes for space with injected
 * memory context — but it carries the SAME facts: which project, which server,
 * and that capture is local until the user joins.
 */
export function trackedProjectBanner(input: TrackedProjectBannerInput): string {
  if (input.state !== 'tracked' || !input.marker) return '';

  const { projectId, serverUrl } = input.marker;
  return [
    '🔗 This project is tracked by a MemSmith team workspace.',
    `   project: ${projectId}`,
    // Omitted rather than rendered as "undefined" for a marker written before
    // serverUrl was recorded.
    ...(serverUrl ? [`   server:  ${serverUrl}`] : []),
    // The load-bearing line. Without it the teammate assumes their work already
    // reaches the team and silently builds up local-only observations.
    '   Your memory is captured LOCALLY until you join — joining needs a team key.',
  ].join('\n');
}
