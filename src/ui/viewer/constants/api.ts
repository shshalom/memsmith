export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STREAM: '/stream',
} as const;

export const V1_ENDPOINTS = {
  SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream',
  DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions',
  DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost',
  SETTINGS: '/v1/settings',
  IDENTITY: '/v1/identity',
} as const;
