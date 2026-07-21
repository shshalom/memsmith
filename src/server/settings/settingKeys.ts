// SPDX-License-Identifier: Apache-2.0

export type SettingType = 'boolean' | 'number' | 'enum' | 'string';

export interface SettingKey {
  key: string;
  type: SettingType;
  env: string;
  default: unknown;
  /** true if changing this still requires a restart to take effect. */
  boot: boolean;
  options?: string[];
  min?: number;
  max?: number;
  label: string;
  /** Short one-liner shown always-visible on the settings row. */
  description: string;
  /** Fuller explanation shown in the ⓘ tooltip: what the setting is for, how
   *  it affects the system, and the effect of on/off or low/high values.
   *  Distinct from `description` (which stays terse). */
  help?: string;
}

export const SETTING_KEYS: readonly SettingKey[] = [
  { key: 'provider', type: 'enum', env: 'MEMSMITH_SERVER_PROVIDER', default: 'ollama',
    boot: false, options: ['ollama', 'claude', 'gemini', 'openrouter'],
    label: 'Generation model', description: "Who distills your team's memory. Switching applies live.",
    help: 'The AI provider that turns raw session activity into stored observations. "ollama" runs a local model on your machine (private, free, no API key); "claude"/"gemini"/"openrouter" call a hosted model (higher quality, needs an API key, costs tokens). Changing this takes effect on the next observation — no restart.' },
  { key: 'model', type: 'string', env: 'MEMSMITH_SERVER_MODEL', default: 'llama3.1:8b',
    boot: false, label: 'Model name',
    description: 'The specific model the provider runs.',
    help: 'The exact model the chosen provider uses to write observations (e.g. "qwen2.5:14b" for ollama, "claude-haiku-4-5" for claude). Larger models write sharper, more accurate memory but are slower and — for hosted providers — more expensive per observation.' },
  { key: 'tiering', type: 'boolean', env: 'MEMSMITH_TIERING', default: true,
    boot: false, label: 'Compression (tiering)',
    description: 'Squeeze older memory to fit the injection budget.',
    help: 'When on, older/less-relevant observations are compressed to shorter summaries so more of them fit inside the token budget injected at session start. You get broader context for the same token cost. Off = observations are injected whole until the budget fills, so you see fewer of them.' },
  { key: 'searchHybrid', type: 'boolean', env: 'MEMSMITH_SEARCH_HYBRID', default: true,
    boot: false, label: 'Hybrid search',
    description: 'Blend keyword + semantic ranking on retrieval.',
    help: 'Controls how memory is found when recalling. On = blends exact keyword matching with semantic (meaning-based) vector search, so a query finds relevant memory even when the words differ. Off = keyword-only, which misses paraphrases and related concepts. Leave on unless you specifically want literal-match-only recall.' },
  { key: 'ftsWeight', type: 'number', env: 'MEMSMITH_FTS_WEIGHT', default: 0.3,
    boot: false, min: 0, max: 1, label: 'Keyword weight',
    description: 'Full-text-search weight in the hybrid blend.',
    help: 'How much exact keyword matches count in hybrid search (0–1). Raise it when precise terms/identifiers matter (function names, error codes); lower it to lean on meaning-based matching. Balanced against Semantic weight — the two together decide result ranking.' },
  { key: 'vecWeight', type: 'number', env: 'MEMSMITH_VEC_WEIGHT', default: 1,
    boot: false, min: 0, max: 1, label: 'Semantic weight',
    description: 'Vector-similarity weight in the hybrid blend.',
    help: 'How much meaning-based (vector) similarity counts in hybrid search (0–1). Raise it to surface conceptually related memory even when wording differs; lower it to favor literal keyword matches. Works together with Keyword weight to rank recall results.' },
  { key: 'rrfK', type: 'number', env: 'MEMSMITH_RRF_K', default: 60,
    boot: false, min: 1, max: 1000, label: 'RRF k',
    description: 'Reciprocal-rank-fusion constant.',
    help: 'A tuning constant for how the keyword and semantic result lists are merged (reciprocal rank fusion). Lower values let the very top hits from each list dominate; higher values blend more evenly across both. The default (60) suits most cases — only change it if recall ordering feels off.' },
  { key: 'supersedeMaxDepth', type: 'number', env: 'MEMSMITH_SUPERSEDE_MAX_DEPTH', default: 20,
    boot: false, min: 1, max: 200, label: 'Supersede depth',
    description: 'Max supersession chain depth to resolve.',
    help: 'When a newer observation supersedes an older one, MemSmith follows that chain to show you the current version. This caps how many links it will follow. Higher = always resolves to the latest even through long edit histories, at a small lookup cost; lower is faster but may show a slightly stale version in deep chains.' },
  { key: 'qualityFloor', type: 'number', env: 'MEMSMITH_QUALITY_FLOOR', default: 20,
    boot: false, min: 0, max: 100, label: 'Quality floor',
    description: 'Minimum quality score to keep a generated observation.',
    help: 'Each generated observation gets a quality score (0–100); anything below this floor is discarded instead of stored. Raise it to keep only high-confidence memory (less noise, but you may drop useful notes); lower it to capture more (fuller memory, but more low-value entries). 0 keeps everything.' },
  { key: 'reformatRetries', type: 'number', env: 'MEMSMITH_REFORMAT_RETRIES', default: 1,
    boot: false, min: 0, max: 5, label: 'Reformat retries',
    description: 'Retries when a model returns malformed output.',
    help: 'If the generation model returns output that doesn\'t parse (bad JSON/format), MemSmith asks it to try again up to this many times before giving up on that observation. Higher = more resilient to flaky models (a few extra tokens per failure); 0 = never retry, so a single malformed response drops the observation.' },
  { key: 'inputRatePerMtok', type: 'number', env: 'MEMSMITH_INPUT_RATE_PER_MTOK', default: 5,
    boot: false, min: 0, max: 1000, label: 'Input rate ($/Mtok)',
    description: 'Price per million input tokens, used for savings estimates.',
    help: 'The dollar price per million input tokens for your model, used ONLY to estimate the cost savings shown on the dashboard — it does not change what you\'re actually charged. Set it to your provider\'s real input rate so the "compression savings" figures reflect reality.' },
  { key: 'monthlyTokenCap', type: 'number', env: 'MEMSMITH_MONTHLY_TOKEN_CAP', default: 0,
    boot: true, min: 0, max: 1_000_000_000, label: 'Monthly token cap',
    description: 'Hard monthly token limit (0 = off). Applies after restart.',
    help: 'A hard ceiling on generation tokens per calendar month — once hit, MemSmith stops generating new observations until the month rolls over. Use it to bound spend on hosted providers. 0 disables the cap (unlimited). Takes effect after a server restart.' },
  { key: 'monthlyRequestCap', type: 'number', env: 'MEMSMITH_MONTHLY_REQUEST_CAP', default: 0,
    boot: true, min: 0, max: 100_000_000, label: 'Monthly request cap',
    description: 'Hard monthly request limit (0 = off). Applies after restart.',
    help: 'A hard ceiling on the number of generation requests per calendar month; once reached, new observations pause until next month. A coarser spend/rate guard than the token cap. 0 disables it. Takes effect after a server restart.' },
  { key: 'rateLimitPerMin', type: 'number', env: 'MEMSMITH_RATE_LIMIT_PER_MIN', default: 0,
    boot: true, min: 0, max: 100_000, label: 'Rate limit / min',
    description: 'Requests per minute per key (0 = off). Applies after restart.',
    help: 'Caps how many requests a single API key may make per minute — protects a shared/team server from being overwhelmed by one client and smooths provider rate-limit pressure. 0 disables throttling. Takes effect after a server restart.' },
  { key: 'userNoteBoost', type: 'boolean', env: 'MEMSMITH_USER_NOTE_BOOST', default: true,
    boot: false, label: 'User-note boost',
    description: 'Float user-directed notes ahead of ambient results in retrieval (on/off).',
    help: 'After ranking, any user_note observations in the result set are moved to the top, ahead of ambient observations, while preserving relative order within each group. Off = keep the raw ranked order. Default on = notes first.' },
  { key: 'identityProvider', type: 'enum', env: 'MEMSMITH_IDENTITY_PROVIDER', default: 'local',
    boot: true, options: ['local', 'better-auth'],
    label: 'Identity provider',
    description: 'Authentication provider for human sessions (local = no login; better-auth = session auth).',
    help: 'Controls how human (non-API-key) requests are authenticated. "local" is the single-user default — any loopback request is treated as the local owner with no login required. "better-auth" enables session-based authentication via better-auth; requires better-auth to be initialised at server startup. Takes effect after a server restart.' },
];

const BY_KEY: Map<string, SettingKey> = new Map(SETTING_KEYS.map(k => [k.key, k]));

export function getSettingKey(key: string): SettingKey | undefined {
  return BY_KEY.get(key);
}

export function validateSettingValue(
  k: SettingKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (k.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    return { ok: false, error: `${k.key} must be a boolean` };
  }
  if (k.type === 'number') {
    const n = typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${k.key} must be a number` };
    if (k.min !== undefined && n < k.min) return { ok: false, error: `${k.key} must be >= ${k.min}` };
    if (k.max !== undefined && n > k.max) return { ok: false, error: `${k.key} must be <= ${k.max}` };
    return { ok: true, value: n };
  }
  if (k.type === 'enum') {
    const s = String(value);
    if (!k.options?.includes(s)) return { ok: false, error: `${k.key} must be one of ${k.options?.join(', ')}` };
    return { ok: true, value: s };
  }
  // string
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: `${k.key} must be a non-empty string` };
  return { ok: true, value };
}

export function coerceEnvValue(k: SettingKey, raw: string): unknown {
  // An empty env value means "unset" — return undefined so the caller falls
  // through to the code default rather than coercing '' to a truthy boolean.
  if (raw === '') return undefined;
  if (k.type === 'boolean') return raw !== '0' && raw.toLowerCase() !== 'off' && raw.toLowerCase() !== 'false';
  if (k.type === 'number') return Number(raw);
  if (k.type === 'enum') return raw.trim().toLowerCase();
  return raw;
}
