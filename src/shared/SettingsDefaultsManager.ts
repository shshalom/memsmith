
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { HOOK_TIMEOUTS, getTimeout } from './hook-constants.js';

/**
 * settings.json is credential-bearing: MEMSMITH_SERVER_API_KEY,
 * MEMSMITH_TEAM_API_KEY, MEMSMITH_GEMINI_API_KEY, MEMSMITH_OPENROUTER_API_KEY
 * and MEMSMITH_TELEGRAM_BOT_TOKEN all live in it.
 *
 * server-bootstrap's persistServerSettings already chmods to 0600 after writing,
 * and the convert writer passes mode 0600 — but this class is the writer that
 * CREATES the file, and it did neither. Measured on a live install:
 * ~/.memsmith/settings.json at 0644 inside a 0755 directory.
 *
 * No secret had leaked only because every credential key on that box happened to
 * be empty (the real ones live in credentials.json, 0600). That is luck. Set an
 * OpenRouter key through the UI and a world-readable file holds a live token.
 *
 * The nested→flat migration was worse: it rewrote the file with no mode, so a
 * file server-bootstrap had deliberately locked to 0600 came back out at 0644.
 */
const SETTINGS_FILE_MODE = 0o600;
const SETTINGS_DIR_MODE = 0o700;

/**
 * Narrow a settings file (and its directory) to owner-only.
 *
 * Best-effort by design. Windows and CIFS do not implement POSIX modes, and a
 * hook that cannot read settings is a worse failure than a loose mode bit — so
 * hardening must never become a new way for loading to throw.
 */
function hardenSettingsPath(settingsPath: string): void {
  try {
    if ((statSync(settingsPath).mode & 0o777) !== SETTINGS_FILE_MODE) {
      chmodSync(settingsPath, SETTINGS_FILE_MODE);
    }
  } catch {
    // Non-POSIX filesystem or a race with another writer; leave as-is.
  }
  try {
    const dir = dirname(settingsPath);
    if ((statSync(dir).mode & 0o777) !== SETTINGS_DIR_MODE) {
      chmodSync(dir, SETTINGS_DIR_MODE);
    }
  } catch {
    // Same rationale as above.
  }
}

export interface SettingsDefaults {
  MEMSMITH_MODEL: string;
  MEMSMITH_CONTEXT_OBSERVATIONS: string;
  MEMSMITH_WORKER_PORT: string;
  MEMSMITH_WORKER_HOST: string;
  MEMSMITH_API_TIMEOUT_MS: string;
  MEMSMITH_SKIP_TOOLS: string;
  MEMSMITH_PROVIDER: string;  
  MEMSMITH_CLAUDE_AUTH_METHOD: string;  
  MEMSMITH_GEMINI_API_KEY: string;
  MEMSMITH_GEMINI_MODEL: string;  
  MEMSMITH_GEMINI_RATE_LIMITING_ENABLED: string;
  MEMSMITH_OPENROUTER_API_KEY: string;
  MEMSMITH_OPENROUTER_MODEL: string;
  MEMSMITH_OPENROUTER_BASE_URL: string;
  MEMSMITH_OPENROUTER_SITE_URL: string;
  MEMSMITH_OPENROUTER_APP_NAME: string;
  MEMSMITH_OLLAMA_URL: string;
  MEMSMITH_OLLAMA_MODEL: string;
  MEMSMITH_DATA_DIR: string;
  MEMSMITH_LOG_LEVEL: string;
  MEMSMITH_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  MEMSMITH_MODE: string;
  MEMSMITH_CONTEXT_SESSION_COUNT: string;
  MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  MEMSMITH_WELCOME_HINT_ENABLED: string;
  MEMSMITH_FOLDER_CLAUDEMD_ENABLED: string;
  MEMSMITH_FOLDER_USE_LOCAL_MD: string;  
  MEMSMITH_TRANSCRIPTS_ENABLED: string;  
  MEMSMITH_TRANSCRIPTS_CONFIG_PATH: string;  
  MEMSMITH_CODEX_TRANSCRIPT_INGESTION: string;
  MEMSMITH_MAX_CONCURRENT_AGENTS: string;  
  MEMSMITH_HOOK_FAIL_LOUD_THRESHOLD: string;  
  MEMSMITH_EXCLUDED_PROJECTS: string;
  MEMSMITH_INCLUDED_PROJECTS: string;  // Allowlist: comma-separated glob patterns; when non-empty, only matching cwds are tracked (exclusions still win)
  MEMSMITH_FOLDER_MD_EXCLUDE: string;
  MEMSMITH_FOLDER_MD_SKELETON_DENYLIST: string;
  MEMSMITH_SEMANTIC_INJECT: string;
  MEMSMITH_SEMANTIC_INJECT_LIMIT: string;
  MEMSMITH_RETRIEVAL_MIN_HITS: string;
  MEMSMITH_RETRIEVAL_TIMEOUT_MS: string;
  MEMSMITH_RETRIEVAL_ENFORCEMENT: string;  // 'soft' | 'hard'
  MEMSMITH_TIER_ROUTING_ENABLED: string;
  MEMSMITH_TIER_SIMPLE_MODEL: string;
  MEMSMITH_TIER_SUMMARY_MODEL: string;
  MEMSMITH_TIER_FAST_MODEL: string;        // #2289 — resolved by $TIER:fast in MEMSMITH_MODEL
  MEMSMITH_TIER_SMART_MODEL: string;       // #2289 — resolved by $TIER:smart in MEMSMITH_MODEL
  MEMSMITH_TELEGRAM_ENABLED: string;
  MEMSMITH_TELEGRAM_BOT_TOKEN: string;
  MEMSMITH_TELEGRAM_CHAT_ID: string;
  MEMSMITH_TELEGRAM_TRIGGER_TYPES: string;
  MEMSMITH_TELEGRAM_TRIGGER_CONCEPTS: string;
  MEMSMITH_QUEUE_ENGINE: string;
  MEMSMITH_REDIS_URL: string;
  MEMSMITH_REDIS_HOST: string;
  MEMSMITH_REDIS_PORT: string;
  MEMSMITH_REDIS_MODE: string;
  MEMSMITH_QUEUE_REDIS_PREFIX: string;
  MEMSMITH_AUTH_MODE: string;
  MEMSMITH_RUNTIME: string;
  // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
  // these first and fall back to the legacy `*_BETA_*` keys below.
  MEMSMITH_SERVER_URL: string;
  MEMSMITH_SERVER_API_KEY: string;
  MEMSMITH_SERVER_PROJECT_ID: string;
  // Legacy keys retained for back-compat with existing settings.json files.
  MEMSMITH_SERVER_BETA_URL: string;
  MEMSMITH_SERVER_BETA_API_KEY: string;
  MEMSMITH_SERVER_BETA_PROJECT_ID: string;
  MEMSMITH_TEAM_INJECT: string;  // Sprint 3 — opt-in team-memory injection at SessionStart (default 'false')
  MEMSMITH_TEAM_SERVER_URL: string;  // Sprint 3 follow-up — server-mode base URL the SessionStart hook calls for team memory (default '' = bridge off)
  MEMSMITH_TEAM_API_KEY: string;  // Sprint 3 follow-up — scoped memories:read key for the team-inject bridge (default '' = bridge off)
  MEMSMITH_GATE_TOOLS: string;  // Hook-activation — comma-separated tools the discovery gate injects before (default '' = gate off; 'none' also disables)
  MEMSMITH_REDISCOVERY_LOG: string;  // Hook-activation — log when memory already held an answer for a discovery query (default 'false')
  MEMSMITH_USER_NOTE_BOOST: string;  // Post-rank boost: floats user_note observations ahead of ambient within the relevant result set (on/off toggle)
  MEMSMITH_RECORD_INTENT_BACKSTOP: string;  // Task 9 — enable /v1/record-intent Layer-2 backstop on UserPromptSubmit (default 'true')
  MEMSMITH_IDENTITY_PROVIDER: string;       // Task 8 (identity-core) — identity provider for human sessions: 'local' | 'better-auth' (default 'local')
}

export class SettingsDefaultsManager {
  private static readonly DEFAULTS: SettingsDefaults = {
    MEMSMITH_MODEL: 'claude-haiku-4-5-20251001',
    MEMSMITH_CONTEXT_OBSERVATIONS: '50',
    MEMSMITH_WORKER_PORT: String(38700 + ((process.getuid?.() ?? 77) % 100)),
    MEMSMITH_WORKER_HOST: '127.0.0.1',
    MEMSMITH_API_TIMEOUT_MS: String(getTimeout(HOOK_TIMEOUTS.API_REQUEST)),
    MEMSMITH_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    MEMSMITH_PROVIDER: 'claude',  // Default to Claude
    MEMSMITH_CLAUDE_AUTH_METHOD: 'subscription',  // Default to logged-in Claude SDK auth (not API key)
    MEMSMITH_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    MEMSMITH_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    MEMSMITH_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    MEMSMITH_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    MEMSMITH_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    MEMSMITH_OPENROUTER_BASE_URL: '',  // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL (e.g. https://api.deepseek.com, http://localhost:1234/v1). Empty = default OpenRouter endpoint.
    MEMSMITH_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    MEMSMITH_OPENROUTER_APP_NAME: 'memsmith',  // App name for OpenRouter analytics
    MEMSMITH_OLLAMA_URL: 'http://localhost:11434/v1',  // Ollama local base URL (OpenAI-compatible)
    MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b',  // Default Ollama model
    MEMSMITH_DATA_DIR: join(homedir(), '.memsmith'),
    MEMSMITH_LOG_LEVEL: 'INFO',
    MEMSMITH_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    MEMSMITH_MODE: 'code', // Default mode profile
    MEMSMITH_CONTEXT_SESSION_COUNT: '10',
    MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    MEMSMITH_WELCOME_HINT_ENABLED: 'true',
    MEMSMITH_FOLDER_CLAUDEMD_ENABLED: 'false',
    MEMSMITH_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    MEMSMITH_TRANSCRIPTS_ENABLED: 'true',
    MEMSMITH_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.memsmith', 'transcript-watch.json'),
    MEMSMITH_CODEX_TRANSCRIPT_INGESTION: 'false',
    MEMSMITH_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Claude SDK agent subprocesses
    MEMSMITH_HOOK_FAIL_LOUD_THRESHOLD: '3',  // Plan 05 Phase 8 — escalate to exit code 2 after N consecutive worker-unreachable hook invocations
    MEMSMITH_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    MEMSMITH_INCLUDED_PROJECTS: '',  // Allowlist: comma-separated glob patterns; empty = capture all (backward compat); non-empty = track only matching cwds (exclusions still win)
    MEMSMITH_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    MEMSMITH_FOLDER_MD_SKELETON_DENYLIST: '[]',  // #2400 — JSON array of glob patterns; when a folder matches AND its generated CLAUDE.md would be empty/skeleton, skip injection (avoids polluting non-content dirs with empty skeletons). Default [] preserves existing behavior.
    MEMSMITH_SEMANTIC_INJECT: 'true',              // Retrieval-first is core: inject relevant memory on every UserPromptSubmit
    MEMSMITH_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    MEMSMITH_RETRIEVAL_MIN_HITS: '1',              // Min /v1/context results to count as a "strong hit" (else gap)
    MEMSMITH_RETRIEVAL_TIMEOUT_MS: '2000',         // Hot-path timeout; on timeout, proceed with no injection
    MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft',        // 'soft' = inject-only; 'hard' = block-eligible on strong hit
    MEMSMITH_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    MEMSMITH_TIER_SIMPLE_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    MEMSMITH_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    MEMSMITH_TIER_FAST_MODEL: 'haiku',              // #2289 — $TIER:fast resolves here (portable alias)
    MEMSMITH_TIER_SMART_MODEL: 'sonnet',            // #2289 — $TIER:smart resolves here (portable alias)
    MEMSMITH_TELEGRAM_ENABLED: 'true',
    MEMSMITH_TELEGRAM_BOT_TOKEN: '',
    MEMSMITH_TELEGRAM_CHAT_ID: '',
    MEMSMITH_TELEGRAM_TRIGGER_TYPES: 'security_alert',
    MEMSMITH_TELEGRAM_TRIGGER_CONCEPTS: '',
    // 'inline', NOT the retired 'sqlite'. buildQueueManager treats anything
    // that is not 'inline' or 'bullmq' as a DisabledServerQueueManager, so
    // shipping 'sqlite' meant every fresh install wrote a value that would
    // silently disable generation entirely — no error, jobs just queue forever.
    //
    // It never bit only by luck: local-runtime.ts forces 'inline' when
    // process.env is empty, and settings.json is never loaded into process.env
    // on that path. Change either half and generation dies quietly. 'inline' is
    // what the local runtime actually uses, so config and behaviour now agree.
    MEMSMITH_QUEUE_ENGINE: 'inline',
    MEMSMITH_REDIS_URL: '',
    MEMSMITH_REDIS_HOST: '127.0.0.1',
    MEMSMITH_REDIS_PORT: '6379',
    MEMSMITH_REDIS_MODE: 'external',
    MEMSMITH_QUEUE_REDIS_PREFIX: `memsmith_${process.env.MEMSMITH_WORKER_PORT ?? String(38700 + ((process.getuid?.() ?? 77) % 100))}`,
    MEMSMITH_AUTH_MODE: 'api-key',
    MEMSMITH_RUNTIME: 'local',
    // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
    // these first; the legacy `*_BETA_*` defaults below remain so existing
    // settings.json files still resolve correctly.
    MEMSMITH_SERVER_URL: `http://127.0.0.1:${process.env.MEMSMITH_SERVER_PORT ?? String(38877 + ((process.getuid?.() ?? 77) % 100))}`,  // Default server runtime URL — UID-derived for multi-account isolation
    MEMSMITH_SERVER_API_KEY: '',                          // Local hook API key, populated by installer when runtime=server
    MEMSMITH_SERVER_PROJECT_ID: '',                       // Default Postgres project_id used by hooks when runtime=server
    MEMSMITH_SERVER_BETA_URL: `http://127.0.0.1:${process.env.MEMSMITH_SERVER_PORT ?? String(38877 + ((process.getuid?.() ?? 77) % 100))}`,  // Legacy server-beta runtime URL — UID-derived for multi-account isolation
    MEMSMITH_SERVER_BETA_API_KEY: '',                     // Legacy local hook API key (read as fallback when MEMSMITH_SERVER_API_KEY unset)
    MEMSMITH_SERVER_BETA_PROJECT_ID: '',                  // Legacy Postgres project_id (read as fallback when MEMSMITH_SERVER_PROJECT_ID unset)
    MEMSMITH_TEAM_INJECT: 'false',                        // Sprint 3 — opt-in team-memory injection at SessionStart (default 'false')
    MEMSMITH_TEAM_SERVER_URL: '',                         // Sprint 3 follow-up — team-inject bridge server URL (default '' = bridge off)
    MEMSMITH_TEAM_API_KEY: '',                            // Sprint 3 follow-up — team-inject bridge scoped key (default '' = bridge off)
    MEMSMITH_GATE_TOOLS: '',                              // Hook-activation — discovery-gate tool list (default '' = gate off)
    MEMSMITH_REDISCOVERY_LOG: 'false',                    // Hook-activation — re-discovery logging (default 'false')
    MEMSMITH_USER_NOTE_BOOST: 'true',                     // Post-rank boost: floats user_note observations ahead of ambient (on/off toggle)
    MEMSMITH_RECORD_INTENT_BACKSTOP: 'true',              // Task 9 — Layer-2 backstop: POST prompt to /v1/record-intent on UserPromptSubmit (default 'true')
    MEMSMITH_IDENTITY_PROVIDER: 'local',                  // Task 8 (identity-core) — identity provider for human sessions (default 'local')
  };

  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  static get(key: keyof SettingsDefaults): string {
    return process.env[key] ?? this.DEFAULTS[key];
  }

  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  static loadFromFile(settingsPath: string, applyEnvOverrides = true): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: SETTINGS_DIR_MODE });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), {
            encoding: 'utf-8',
            mode: SETTINGS_FILE_MODE,
          });
          // mkdir/open honour the process umask, so the mode above is a ceiling
          // rather than a guarantee. chmod explicitly.
          hardenSettingsPath(settingsPath);
          // stderr, never stdout: this fires on the first boot in a fresh data
          // dir, and CLI commands like `start` promise machine-readable JSON
          // on stdout to the hook framework.
          console.warn('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error instanceof Error ? error.message : String(error));
        }
        return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
      }

      // Reading is the one moment we are guaranteed to touch an existing file,
      // so it is where an install that predates this fix gets repaired. Without
      // this, the hardening would only ever help fresh installs and every
      // already-exposed settings.json would stay exposed forever.
      hardenSettingsPath(settingsPath);

      const settingsData = readFileSync(settingsPath, 'utf-8');
      // Strip UTF-8 BOM if present — Windows tools (editors, formatters, CLI
      // hooks) may prepend U+FEFF which Bun's JSON.parse rejects silently,
      // causing a full fallback to defaults and breaking server-beta routing.
      const settings = JSON.parse(settingsData.replace(/^\uFEFF/, ''));

      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        flatSettings = settings.env;

        try {
          // Preserve the 0600 that server-bootstrap deliberately set; a bare
          // writeFileSync here silently widened it back to 0644.
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), {
            encoding: 'utf-8',
            mode: SETTINGS_FILE_MODE,
          });
          hardenSettingsPath(settingsPath);
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with in-memory migration even if write fails
        }
      }

      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return applyEnvOverrides ? this.applyEnvOverrides(result) : result;
    } catch (error: unknown) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error instanceof Error ? error.message : String(error));
      const defaults = this.getAllDefaults();
      return applyEnvOverrides ? this.applyEnvOverrides(defaults) : defaults;
    }
  }
}
