export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
}

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  MEMSMITH_MODEL: string;
  MEMSMITH_CONTEXT_OBSERVATIONS: string;
  MEMSMITH_WORKER_PORT: string;
  MEMSMITH_WORKER_HOST: string;

  MEMSMITH_PROVIDER?: string;  
  MEMSMITH_GEMINI_API_KEY?: string;
  MEMSMITH_GEMINI_MODEL?: string;  
  MEMSMITH_GEMINI_RATE_LIMITING_ENABLED?: string;  
  MEMSMITH_OPENROUTER_API_KEY?: string;
  MEMSMITH_OPENROUTER_MODEL?: string;
  MEMSMITH_OPENROUTER_SITE_URL?: string;
  MEMSMITH_OPENROUTER_APP_NAME?: string;

  MEMSMITH_CONTEXT_SHOW_READ_TOKENS?: string;
  MEMSMITH_CONTEXT_SHOW_WORK_TOKENS?: string;
  MEMSMITH_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  MEMSMITH_CONTEXT_FULL_COUNT?: string;
  MEMSMITH_CONTEXT_FULL_FIELD?: string;
  MEMSMITH_CONTEXT_SESSION_COUNT?: string;

  MEMSMITH_CONTEXT_SHOW_LAST_SUMMARY?: string;
  MEMSMITH_CONTEXT_SHOW_LAST_MESSAGE?: string;
}
