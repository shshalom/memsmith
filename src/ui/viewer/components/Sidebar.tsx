import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { VIEWS, ViewId } from '../views/viewState';

interface SidebarProps {
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
  projects: string[];
  currentProject: string;
  onProjectChange: (project: string) => void;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

export function Sidebar({
  activeView,
  onSelect,
  projects,
  currentProject,
  onProjectChange,
  themePreference,
  onThemeChange,
}: SidebarProps) {
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

      {/* Footer: project selector + theme toggle */}
      <div className="sidebar-footer">
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
        <ThemeToggle preference={themePreference} onThemeChange={onThemeChange} />
      </div>
    </nav>
  );
}
