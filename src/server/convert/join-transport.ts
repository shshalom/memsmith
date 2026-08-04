// SPDX-License-Identifier: Apache-2.0
//
// How a join reaches the team: over HTTPS (preferred) or over a direct Postgres
// connection (retained for migration only — see the spec's §4.1).
//
// The Postgres path is the ONLY one that still requires a teammate to hold a
// database password, so it is deprecated and must not be offered in the
// teammate-facing UI. It is retained deliberately, for a team already converted
// against a raw Postgres URL whose owner necessarily already has that URL.

/** The outcome of registering this project under a team on the remote. */
export type JoinRegisterResult =
  | { status: 'joined'; teamId: string }
  | { status: 'failed'; error: string };

export interface JoinTransport {
  register: (input: {
    /** Base URL of the team server, e.g. https://team.example.com */
    serverUrl: string;
    /** The team's key, from the invite. */
    teamKey: string;
    /** This machine's project, about to become team-scoped. */
    projectId: string;
    projectName?: string;
  }) => Promise<JoinRegisterResult>;
}
