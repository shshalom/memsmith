// SPDX-License-Identifier: Apache-2.0
//
// Tell a teammate that the project they just installed into already has a team.
//
// The product owner's requirement: "they going to check out the project, and if
// it their first time they going to install memsmith. During install memsmith
// should identify whether or not it has memsmith configuration and identity, so
// it will pick things up."
//
// install.ts asked nothing of the kind — 1,922 lines with no reference to the
// marker. A teammate cloning a converted project saw the generic success
// message and no sign that a team workspace existed.
//
// WHAT THIS DOES NOT DO: it does not join. The marker is a non-secret pointer
// and carries no credential by design, so recognition can establish WHO the
// project is but never that this machine may act as it. Capture stays local
// until the user supplies the team key — which is also the product rule ("if
// identity exists and the user didn't join then the work is offline / local").
// Saying anything stronger here would tell the user their work is reaching the
// team when it is not.

import type { JoinState } from '../../services/identity/join-state.js';

export interface TrackedProjectInput {
  state: JoinState;
  marker: { teamId: string; projectId: string; runtime?: string; serverUrl?: string } | null;
}

export interface TrackedProjectNotice {
  title: string;
  body: string;
  /** True when there is something for the user to do (join). */
  actionable: boolean;
}

/**
 * Build the install-time notice, or null when there is nothing to say.
 *
 * Pure: takes the already-classified state so the installer decides how to
 * render it (prompt when interactive, print when not) and this stays testable
 * without running an install.
 */
export function trackedProjectNotice(input: TrackedProjectInput): TrackedProjectNotice | null {
  // Nothing to announce for a plain directory or a purely local project.
  // Announcing a team where none exists would be a lie, and this is by far the
  // most common install.
  if (input.state === 'untracked' || !input.marker) return null;

  const { projectId, serverUrl } = input.marker;

  if (input.state === 'joined') {
    // This machine already holds the key. Confirm it and offer nothing —
    // prompting someone to join a team they are in is noise.
    return {
      title: 'Team project',
      body: [
        `This project is part of a MemSmith team workspace.`,
        `  project: ${projectId}`,
        ...(serverUrl ? [`  server:  ${serverUrl}`] : []),
        `This machine is already connected.`,
      ].join('\n'),
      actionable: false,
    };
  }

  // 'tracked': the marker names a team this machine cannot open yet.
  return {
    title: 'Team project detected',
    body: [
      `This project is tracked by a MemSmith team workspace.`,
      `  project: ${projectId}`,
      // Omitted rather than printed as "undefined" for a marker written before
      // serverUrl was recorded.
      ...(serverUrl ? [`  server:  ${serverUrl}`] : []),
      ``,
      // The most important line: without it the teammate assumes their work is
      // already reaching the team and silently accumulates local-only work.
      `Your memory is captured LOCALLY until you join. Joining needs a team key`,
      `from whoever set the workspace up — MemSmith cannot mint one for you.`,
    ].join('\n'),
    actionable: true,
  };
}
