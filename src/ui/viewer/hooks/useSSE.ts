import { useState, useEffect, useRef } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { V1_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { adaptObservation } from '../utils/serverAdapter.js';
import { fetchObservations } from '../utils/serverData.js';
import { shouldFallbackToPolling } from './sse-fallback.js';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const streamErroredRef = useRef(false);

  const addProjectIfNew = (project: string) => {
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
  };

  const stopPolling = () => {
    if (pollIntervalRef.current !== undefined) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
  };

  const startPolling = () => {
    if (pollIntervalRef.current !== undefined) return; // already polling
    console.log('[SSE] Starting polling fallback via fetchObservations');
    const poll = async () => {
      try {
        const fetched = await fetchObservations();
        if (fetched.length > 0) {
          setObservations(fetched);
          fetched.forEach(obs => addProjectIfNew(obs.project));
        }
      } catch (e) {
        console.error('[SSE] Polling fallback error:', e);
      }
    };
    poll(); // immediate first fetch
    pollIntervalRef.current = setInterval(poll, TIMING.SSE_RECONNECT_DELAY_MS * 2);
  };

  useEffect(() => {
    const connect = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(V1_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected to /v1/stream');
        streamErroredRef.current = false;
        stopPolling();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        eventSource.close();
        streamErroredRef.current = true;

        if (shouldFallbackToPolling({ streamErrored: streamErroredRef.current, reconnecting: true })) {
          startPolling();
        }

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined;
          console.log('[SSE] Attempting to reconnect to /v1/stream...');
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          console.error('[SSE] Failed to parse event data:', e);
          return;
        }

        switch (data.type) {
          case 'initial_load':
            console.log('[SSE] Initial load:', {
              projects: Array.isArray(data.projects) ? data.projects.length : 0,
            });
            if (Array.isArray(data.projects)) {
              setProjects(data.projects as string[]);
            }
            break;

          case 'new_observation':
            if (data.observation) {
              // Server-shaped row must be adapted before entering state
              const adapted = adaptObservation(data.observation as Parameters<typeof adaptObservation>[0]);
              console.log('[SSE] New observation:', adapted.id);
              addProjectIfNew(adapted.project);
              setObservations(prev => [adapted, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              const summary = data.summary as Summary;
              console.log('[SSE] New summary:', summary.id);
              addProjectIfNew(summary.project);
              setSummaries(prev => [summary, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              const prompt = data.prompt as UserPrompt;
              console.log('[SSE] New prompt:', prompt.id);
              addProjectIfNew(prompt.project);
              setPrompts(prev => [prompt, ...prev]);
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              console.log('[SSE] Processing status:', data.isProcessing, 'Queue depth:', data.queueDepth);
              setIsProcessing(data.isProcessing);
              setQueueDepth(typeof data.queueDepth === 'number' ? data.queueDepth : 0);
            }
            break;
        }
      };
    };

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      stopPolling();
    };
  }, []);

  return {
    observations,
    summaries,
    prompts,
    projects,
    isProcessing,
    queueDepth,
  };
}
