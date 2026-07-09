import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { ObservationsView } from './views/ObservationsView';
import { DashboardView } from './views/DashboardView';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { getInitialView, ViewId } from './views/viewState';

export function App() {
  const [activeView, setActiveView] = useState<ViewId>(getInitialView());
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);

  const { projects, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        onSelect={setActiveView}
        projects={projects}
        currentProject={currentFilter}
        onProjectChange={setCurrentFilter}
        themePreference={preference}
        onThemeChange={setThemePreference}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
      />

      <div className="app-main">
        {activeView === 'observations' && <ObservationsView />}
        {activeView === 'dashboard' && <DashboardView />}

        {!welcomeDismissed && (
          <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
        )}

        <ContextSettingsModal
          isOpen={contextPreviewOpen}
          onClose={toggleContextPreview}
          settings={settings}
          onSave={saveSettings}
          isSaving={isSaving}
          saveStatus={saveStatus}
        />

        <button
          className="console-toggle-btn"
          onClick={toggleLogsModal}
          title="Toggle Console"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
        </button>

        <LogsDrawer
          isOpen={logsModalOpen}
          onClose={toggleLogsModal}
        />
      </div>
    </div>
  );
}
