import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { ObservationsView } from './views/ObservationsView';
import { DashboardView } from './views/DashboardView';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { getInitialView, ViewId } from './views/viewState';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const [activeView, setActiveView] = useState<ViewId>(getInitialView());
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);

  const matchesSelection = useCallback((item: { project: string }) => {
    return !currentFilter || item.project === currentFilter;
  }, [currentFilter]);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesSelection);
    const paginated = paginatedObservations.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSelection]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesSelection);
    const paginated = paginatedSummaries.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSelection]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesSelection);
    const paginated = paginatedPrompts.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSelection]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const handleLoadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts]);
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination.observations, pagination.summaries, pagination.prompts]);

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

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
      />

      <div className="app-main">
        <Header
          projects={projects}
          currentFilter={currentFilter}
          onFilterChange={setCurrentFilter}
          isProcessing={isProcessing}
          queueDepth={queueDepth}
          themePreference={preference}
          onThemeChange={setThemePreference}
          onContextPreviewToggle={toggleContextPreview}
          onShowHelp={() => {
            setStoredWelcomeDismissed(false);
            setWelcomeDismissed(false);
          }}
        />

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
