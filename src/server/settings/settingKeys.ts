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
  description: string;
}

export const SETTING_KEYS: readonly SettingKey[] = [
  { key: 'provider', type: 'enum', env: 'MEMSMITH_SERVER_PROVIDER', default: 'ollama',
    boot: false, options: ['ollama', 'claude', 'gemini', 'openrouter'],
    label: 'Generation model', description: "Who distills your team's memory. Switching applies live." },
  { key: 'model', type: 'string', env: 'MEMSMITH_SERVER_MODEL', default: 'llama3.1:8b',
    boot: false, label: 'Model name', description: 'The specific model the provider runs.' },
  { key: 'tiering', type: 'boolean', env: 'MEMSMITH_TIERING', default: true,
    boot: false, label: 'Compression (tiering)', description: 'Squeeze older memory to fit the injection budget.' },
  { key: 'searchHybrid', type: 'boolean', env: 'MEMSMITH_SEARCH_HYBRID', default: true,
    boot: false, label: 'Hybrid search', description: 'Blend keyword + semantic ranking on retrieval.' },
  { key: 'ftsWeight', type: 'number', env: 'MEMSMITH_FTS_WEIGHT', default: 0.3,
    boot: false, min: 0, max: 1, label: 'Keyword weight', description: 'Full-text-search weight in the hybrid blend.' },
  { key: 'vecWeight', type: 'number', env: 'MEMSMITH_VEC_WEIGHT', default: 1,
    boot: false, min: 0, max: 1, label: 'Semantic weight', description: 'Vector-similarity weight in the hybrid blend.' },
  { key: 'rrfK', type: 'number', env: 'MEMSMITH_RRF_K', default: 60,
    boot: false, min: 1, max: 1000, label: 'RRF k', description: 'Reciprocal-rank-fusion constant.' },
  { key: 'supersedeMaxDepth', type: 'number', env: 'MEMSMITH_SUPERSEDE_MAX_DEPTH', default: 20,
    boot: false, min: 1, max: 200, label: 'Supersede depth', description: 'Max supersession chain depth to resolve.' },
  { key: 'qualityFloor', type: 'number', env: 'MEMSMITH_QUALITY_FLOOR', default: 20,
    boot: false, min: 0, max: 100, label: 'Quality floor', description: 'Minimum quality score to keep a generated observation.' },
  { key: 'reformatRetries', type: 'number', env: 'MEMSMITH_REFORMAT_RETRIES', default: 1,
    boot: false, min: 0, max: 5, label: 'Reformat retries', description: 'Retries when a model returns malformed output.' },
  { key: 'inputRatePerMtok', type: 'number', env: 'MEMSMITH_INPUT_RATE_PER_MTOK', default: 5,
    boot: false, min: 0, max: 1000, label: 'Input rate ($/Mtok)', description: 'Price per million input tokens, used for savings estimates.' },
  { key: 'monthlyTokenCap', type: 'number', env: 'MEMSMITH_MONTHLY_TOKEN_CAP', default: 0,
    boot: true, min: 0, max: 1_000_000_000, label: 'Monthly token cap', description: 'Hard monthly token limit (0 = off). Applies after restart.' },
  { key: 'monthlyRequestCap', type: 'number', env: 'MEMSMITH_MONTHLY_REQUEST_CAP', default: 0,
    boot: true, min: 0, max: 100_000_000, label: 'Monthly request cap', description: 'Hard monthly request limit (0 = off). Applies after restart.' },
  { key: 'rateLimitPerMin', type: 'number', env: 'MEMSMITH_RATE_LIMIT_PER_MIN', default: 0,
    boot: true, min: 0, max: 100_000, label: 'Rate limit / min', description: 'Requests per minute per key (0 = off). Applies after restart.' },
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
