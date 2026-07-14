import { useState, useCallback } from 'react';
import type { Settings } from '../types';

// Worker retirement — the viewer's context-preview feature previously fetched
// `/api/projects` and `/api/context/preview` from the legacy worker. Both
// routes were served by the now-retired worker and have no equivalent on the
// local/server runtime (`/v1/search`, `/v1/context`, and `/v1/settings` are
// the current endpoints — none exposes a project catalog or a rendered context
// preview in the format the viewer expects).
//
// Graceful disable: the hook returns an empty state with an "unavailable" error
// message so the ContextSettingsModal shows a clean affordance instead of a
// broken/hung fetch or console errors.

interface UseContextPreviewResult {
  preview: string;
  isLoading: boolean;
  error: string | null;
  projects: string[];
  sources: string[];
  selectedSource: string | null;
  setSelectedSource: (source: string) => void;
  selectedProject: string | null;
  setSelectedProject: (project: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useContextPreview(_settings: Settings): UseContextPreviewResult {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const noopSetSource = useCallback((source: string) => {
    setSelectedSource(source);
  }, []);

  const noopSetProject = useCallback((project: string) => {
    setSelectedProject(project);
  }, []);

  return {
    preview: '',
    isLoading: false,
    error: 'Context preview is not available on the local runtime.',
    projects: [],
    sources: [],
    selectedSource,
    setSelectedSource: noopSetSource,
    selectedProject,
    setSelectedProject: noopSetProject,
  };
}
