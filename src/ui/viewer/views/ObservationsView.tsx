import React, { useState, useEffect, useCallback } from 'react';
import { Feed } from '../components/Feed';
import { fetchObservations } from '../utils/serverData';
import type { Observation } from '../types';

// MemSmith canonical observation taxonomy (the `code` mode's observation_types,
// see plugin/modes/code.json). These are the types the server runtime actually
// classifies observations into — NOT the legacy claude-mem set. Filter chips
// must match the real taxonomy or they filter to nothing.
const OBS_TYPES = [
  'discovery', 'feature', 'bugfix', 'refactor', 'change',
  'decision', 'security_alert', 'security_note',
] as const;

const LIFECYCLES = [
  'open', 'active', 'blocked', 'deferred', 'resolved', 'superseded',
] as const;

export function ObservationsView() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeType, setActiveType] = useState<string>('');
  const [activeLifecycle, setActiveLifecycle] = useState<string>('');
  const [myNotesActive, setMyNotesActive] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce the search query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async (opts: { query?: string; type?: string; lifecycle?: string; userDirected?: boolean }) => {
    setIsLoading(true);
    try {
      const result = await fetchObservations(opts);
      setObservations(result);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load and reload when filters change
  useEffect(() => {
    load({
      query: debouncedQuery || undefined,
      type: activeType || undefined,
      lifecycle: activeLifecycle || undefined,
      userDirected: myNotesActive || undefined,
    });
  }, [debouncedQuery, activeType, activeLifecycle, myNotesActive, load]);

  const handleTypeChip = (t: string) => {
    setActiveType(prev => (prev === t ? '' : t));
  };

  const handleLifecycleChip = (lc: string) => {
    setActiveLifecycle(prev => (prev === lc ? '' : lc));
  };

  const handleMyNotesChip = () => {
    setMyNotesActive(prev => !prev);
  };

  return (
    <div className="observations-view">
      <div className="obs-filters">
        <div className="obs-search-row">
          <input
            className="obs-search-input"
            type="text"
            placeholder="Search observations…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search observations"
          />
        </div>
        <div className="obs-chips-row">
          {OBS_TYPES.map(t => (
            <button
              key={t}
              className={`obs-chip obs-chip--type${activeType === t ? ' obs-chip--active' : ''}`}
              onClick={() => handleTypeChip(t)}
              aria-pressed={activeType === t}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="obs-chips-row">
          {LIFECYCLES.map(lc => (
            <button
              key={lc}
              className={`obs-chip obs-chip--lifecycle${activeLifecycle === lc ? ' obs-chip--active' : ''}`}
              onClick={() => handleLifecycleChip(lc)}
              aria-pressed={activeLifecycle === lc}
            >
              {lc}
            </button>
          ))}
          <button
            className={`obs-chip obs-chip--user-note${myNotesActive ? ' obs-chip--active' : ''}`}
            onClick={handleMyNotesChip}
            aria-pressed={myNotesActive}
          >
            My notes
          </button>
        </div>
      </div>
      <Feed
        observations={observations}
        summaries={[]}
        prompts={[]}
        onLoadMore={() => {}}
        isLoading={isLoading}
        hasMore={false}
      />
    </div>
  );
}
