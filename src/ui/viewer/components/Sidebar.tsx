import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { VIEWS, ViewId } from '../views/viewState';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';

interface SidebarProps {
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
  projects: string[];
  currentProject: string;
  onProjectChange: (project: string) => void;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  isProcessing: boolean;
  queueDepth: number;
  onShowHelp?: () => void;
}

export function Sidebar({
  activeView,
  onSelect,
  projects,
  currentProject,
  onProjectChange,
  themePreference,
  onThemeChange,
  isProcessing,
  queueDepth,
  onShowHelp,
}: SidebarProps) {
  useSpinningFavicon(isProcessing);

  return (
    <nav className="sidebar" aria-label="Main navigation">
      {/* Brand */}
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon" aria-hidden="true">◆</span>
        <span className="sidebar-brand-name">MemSmith</span>
      </div>

      {/* View navigation */}
      <ul className="sidebar-nav" role="list">
        {VIEWS.map(view => (
          <li key={view.id}>
            <button
              className={`sidebar-nav-item${activeView === view.id ? ' sidebar-nav-item--active' : ''}`}
              onClick={() => onSelect(view.id)}
              aria-current={activeView === view.id ? 'page' : undefined}
            >
              {view.label}
            </button>
          </li>
        ))}
      </ul>

      {/* TODO(team-identity): team switcher + member list here */}

      {/* Status area: processing indicator + action buttons */}
      <div className="sidebar-status">
        <div className="sidebar-status-indicator" aria-label={isProcessing ? 'Processing' : 'Idle'}>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <img
              src="memsmith-logomark.webp"
              alt=""
              className={`logomark logomark--small${isProcessing ? ' spinning' : ''}`}
            />
            {queueDepth > 0 && (
              <div className="queue-bubble">{queueDepth}</div>
            )}
          </div>
        </div>
        <div className="sidebar-status-actions">
          <button
            className="sidebar-icon-btn"
            onClick={() => onShowHelp?.()}
            title="Show welcome card"
            aria-label="Show welcome card"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* Footer: project selector + theme toggle. The selector only appears when
          there is genuinely more than one project to switch between — in
          single-project (local) mode it's a dead "All Projects" control, so we
          hide it to avoid implying a multi-project scope that doesn't exist. */}
      <div className="sidebar-footer">
        {projects.length > 1 && (
          <select
            className="sidebar-project-select"
            value={currentProject}
            onChange={e => onProjectChange(e.target.value)}
            aria-label="Select project"
          >
            <option value="">All Projects</option>
            {projects.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
        <ThemeToggle preference={themePreference} onThemeChange={onThemeChange} />
      </div>
    </nav>
  );
}
