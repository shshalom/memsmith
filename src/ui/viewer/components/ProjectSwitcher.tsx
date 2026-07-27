// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';
import { fetchProjects, ProjectSummary } from '../utils/serverData.js';
import { projectSwitchUrl } from '../utils/projectScope.js';

interface ProjectSwitcherProps {
  /** The project this dashboard is currently scoped to, from `?project=`. */
  scopedProjectId: string;
}

function runtimeLabel(runtime: ProjectSummary['runtime']): string {
  return runtime === 'team' ? 'Team' : 'Local';
}

/**
 * Header + switcher: always names the current project and its runtime
 * ("ms-p3-fresh · Local"), and lets the user jump to any other project this
 * machine holds a key for.
 *
 * `GET /v1/projects` is loopback-gated and may not exist on every server
 * (older builds, or a request that fails the loopback gate). Degrading to
 * nothing -- or just the current project's name with no picker -- on a
 * missing/erroring endpoint is required behaviour, not a stopgap: the header
 * must never show stale or fabricated project info.
 */
export function ProjectSwitcher({ scopedProjectId }: ProjectSwitcherProps) {
  const [entries, setEntries] = useState<ProjectSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjects().then(list => { if (!cancelled) setEntries(list); });
    return () => { cancelled = true; };
  }, []);

  // Loading, endpoint missing, or genuinely empty -- render nothing. There is
  // nothing honest to say about the current project without this data.
  if (!entries || entries.length === 0) return null;

  const current = entries.find(p => p.isCurrent) ?? entries.find(p => p.projectId === scopedProjectId);

  const handleSelect = (projectId: string) => {
    if (!projectId || projectId === current?.projectId) return;
    location.href = projectSwitchUrl(location.pathname, location.search, projectId);
  };

  // Only the current project is known and there is nothing else to switch
  // to -- show the headline without a picker control.
  if (entries.length === 1) {
    return (
      <div className="sidebar-project-header" aria-label="Current project">
        {current && (
          <span className="sidebar-project-headline">
            {current.name} <span className="sidebar-project-runtime">· {runtimeLabel(current.runtime)}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="sidebar-project-header" aria-label="Current project and switcher">
      {current && (
        <span className="sidebar-project-headline">
          {current.name} <span className="sidebar-project-runtime">· {runtimeLabel(current.runtime)}</span>
        </span>
      )}
      <select
        className="sidebar-project-switch"
        value={current?.projectId ?? ''}
        onChange={e => handleSelect(e.target.value)}
        aria-label="Switch project"
      >
        {entries.map(p => (
          <option key={p.projectId} value={p.projectId}>
            {p.name} · {runtimeLabel(p.runtime)}
          </option>
        ))}
      </select>
    </div>
  );
}
