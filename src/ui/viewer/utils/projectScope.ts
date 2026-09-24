// SPDX-License-Identifier: Apache-2.0
//
// The SPA is scoped to a project via `?project=<id>` on the page URL, which
// the server reads on `GET /` to (re)issue a scoping cookie. Bare `/` is a
// legitimate first-visit case and correctly falls back to the server's own
// project -- that server-side default is NOT something this file changes.
//
// The bug this file fixes: once `?project=` is present, the SPA must never
// silently drop it. Before this, the only URLSearchParams use in the viewer
// was pagination, so any client-side navigation (or a plain link) that didn't
// carry the parameter forward reverted scope back to the server's project.
//
// These are pure functions (no DOM access) so they're unit-testable without a
// browser -- see the "known verification limit" in the design doc: nobody
// here can drive a real browser, so keeping this logic framework-free and
// pure is what makes it verifiable at all.

export const PROJECT_PARAM = 'project';

/** Read `?project=` from a search string (e.g. `location.search`). Empty/absent → ''. */
export function readProjectParam(search: string): string {
  return new URLSearchParams(search).get(PROJECT_PARAM) ?? '';
}

/**
 * Rebuild a search string with `project` set to `projectId`, preserving every
 * other existing parameter. Passing '' removes the parameter entirely, which
 * keeps a bare `/` truly bare (no `?project=`) rather than pinning an empty
 * value into the URL.
 */
export function withProjectParam(search: string, projectId: string): string {
  const params = new URLSearchParams(search);
  if (projectId) {
    params.set(PROJECT_PARAM, projectId);
  } else {
    params.delete(PROJECT_PARAM);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Build the path+query to navigate to in order to select `projectId`. */
export function projectSwitchUrl(pathname: string, currentSearch: string, projectId: string): string {
  return `${pathname}${withProjectParam(currentSearch, projectId)}`;
}

/**
 * Attach the page's current project to an API endpoint, as `?projectId=`.
 *
 * ONE helper because doing this per-call-site kept going wrong. Six viewer fetch
 * sites need it, and they were fixed one at a time as each broken panel was
 * reported: the metrics tile, then the Observations tab, then Settings — each
 * time the same omission, each time a separate round trip with the user.
 *
 * The server reads `projectId` (the /v1 API's spelling) while the page URL uses
 * `project` (the SPA's spelling), which is exactly the mismatch that made a
 * request look scoped while arriving unscoped. Translating in one place means a
 * new fetch site cannot get it wrong by forgetting, only by not calling this.
 *
 * Without it a request is unscoped, so the server answers for whatever the
 * cookie names — or, for a project whose credential it cannot validate, 401s and
 * the panel renders empty.
 */
export function withApiProject(endpoint: string, search: string): string {
  const project = readProjectParam(search);
  if (!project) return endpoint;
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}projectId=${encodeURIComponent(project)}`;
}

/** `withApiProject` against the live page URL. Safe outside a browser. */
export function apiUrl(endpoint: string): string {
  return typeof location === 'undefined'
    ? endpoint
    : withApiProject(endpoint, location.search);
}
