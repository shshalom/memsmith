// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { readProjectParam } from '../utils/projectScope.js';

/**
 * Holds the `?project=` value the page was loaded with, for the lifetime of
 * the SPA session. Read once on mount -- this is the app's one source of
 * truth for "which project is this dashboard scoped to," so no view can
 * accidentally drop it by omission.
 *
 * A load with no `?project=` behaves exactly as today: empty string, meaning
 * "whatever the server's bare-`/` default resolved to." That default is a
 * server-side decision (see design doc Item 2) and is intentionally left
 * alone here.
 */
export function useProjectScope(): string {
  const [projectId] = useState<string>(() => {
    if (typeof location === 'undefined') return '';
    return readProjectParam(location.search);
  });

  // Defensive sync: keep the URL's `project` param matching what the app
  // believes its scope is, so nothing downstream (a stray navigation, a
  // future router) can silently regress the query string back to bare `/`
  // while React state still thinks it's scoped.
  useEffect(() => {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    if (!projectId) return;
    const current = readProjectParam(location.search);
    if (current === projectId) return;
    const params = new URLSearchParams(location.search);
    params.set('project', projectId);
    const qs = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }, [projectId]);

  return projectId;
}
