
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { ModeManager } from '../../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { snapshotDependencyHealth } from '../../../../shared/dependency-health.js';

const toggleMcpSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));
    app.get('/api/settings/dependency-health', this.handleGetDependencyHealth.bind(this));

    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', validateBody(toggleMcpSchema), this.handleToggleMcp.bind(this));
  }

  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(settings);
  });

  private handleGetDependencyHealth = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(snapshotDependencyHealth());
  });

  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    const settingsPath = paths.settings();
    this.ensureSettingsFile(settingsPath);
    let settings: any = {};

    if (existsSync(settingsPath)) {
      const settingsData = readFileSync(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(settingsData);
      } catch (parseError) {
        const normalizedParseError = parseError instanceof Error ? parseError : new Error(String(parseError));
        logger.error('HTTP', 'Failed to parse settings file', { settingsPath }, normalizedParseError);
        res.status(500).json({
          success: false,
          error: `Settings file is corrupted. Delete ${settingsPath} to reset.`
        });
        return;
      }
    }

    const settingKeys = [
      'MEMSMITH_MODEL',
      'MEMSMITH_CONTEXT_OBSERVATIONS',
      'MEMSMITH_WORKER_PORT',
      'MEMSMITH_WORKER_HOST',
      'MEMSMITH_PROVIDER',
      'MEMSMITH_CLAUDE_AUTH_METHOD',
      'MEMSMITH_GEMINI_API_KEY',
      'MEMSMITH_GEMINI_MODEL',
      'MEMSMITH_GEMINI_RATE_LIMITING_ENABLED',
      'MEMSMITH_OPENROUTER_API_KEY',
      'MEMSMITH_OPENROUTER_MODEL',
      'MEMSMITH_OPENROUTER_SITE_URL',
      'MEMSMITH_OPENROUTER_APP_NAME',
      'MEMSMITH_OLLAMA_URL',
      'MEMSMITH_OLLAMA_MODEL',
      'MEMSMITH_DATA_DIR',
      'MEMSMITH_LOG_LEVEL',
      'MEMSMITH_PYTHON_VERSION',
      'CLAUDE_CODE_PATH',
      'MEMSMITH_CONTEXT_SHOW_READ_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_WORK_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT',
      'MEMSMITH_CONTEXT_OBSERVATION_TYPES',
      'MEMSMITH_CONTEXT_OBSERVATION_CONCEPTS',
      'MEMSMITH_CONTEXT_FULL_COUNT',
      'MEMSMITH_CONTEXT_FULL_FIELD',
      'MEMSMITH_CONTEXT_SESSION_COUNT',
      'MEMSMITH_CONTEXT_SHOW_LAST_SUMMARY',
      'MEMSMITH_CONTEXT_SHOW_LAST_MESSAGE',
      'MEMSMITH_FOLDER_CLAUDEMD_ENABLED',
      // Generation timeout — local models (Ollama) on large prompts can exceed
      // the 30s default; this key was previously missing from the whitelist so
      // POSTs to change it were silently dropped.
      'MEMSMITH_API_TIMEOUT_MS',
    ];
    const allowed = new Set(settingKeys);

    // The viewer UI POSTs the FULL settings object, so we can't hard-reject
    // unknown keys. But we MUST report honestly: apply only whitelisted keys,
    // and surface which submitted keys were ignored + how many actually
    // changed — a POST that changed nothing must not silently report plain
    // success (the old bug: unknown keys dropped, `success:true` returned).
    let changed = 0;
    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        settings[key] = req.body[key];
        changed++;
      }
    }
    const ignored = Object.keys(req.body as Record<string, unknown>).filter(k => !allowed.has(k));

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    clearPortCache();

    logger.info('WORKER', 'Settings updated', { changed, ignoredCount: ignored.length });
    res.json({
      success: true,
      message: `Settings updated (${changed} applied${ignored.length ? `, ${ignored.length} unknown key(s) ignored` : ''})`,
      changed,
      ...(ignored.length ? { ignored } : {}),
    });
  });

  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body as z.infer<typeof toggleMcpSchema>;

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  private validateSettings(settings: any): { valid: boolean; error?: string } {
    if (settings.MEMSMITH_PROVIDER) {
    const validProviders = ['claude', 'gemini', 'openrouter', 'ollama'];
    if (!validProviders.includes(settings.MEMSMITH_PROVIDER)) {
      return { valid: false, error: 'MEMSMITH_PROVIDER must be "claude", "gemini", "openrouter", or "ollama"' };
      }
    }

    if (settings.MEMSMITH_CLAUDE_AUTH_METHOD) {
      const validClaudeAuthMethods = ['subscription', 'api-key', 'gateway', 'cli'];
      if (!validClaudeAuthMethods.includes(settings.MEMSMITH_CLAUDE_AUTH_METHOD)) {
        return { valid: false, error: 'MEMSMITH_CLAUDE_AUTH_METHOD must be "subscription", "api-key", "gateway", or "cli"' };
      }
    }

    if (settings.MEMSMITH_GEMINI_MODEL) {
      const validGeminiModels = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3-flash-preview'];
      if (!validGeminiModels.includes(settings.MEMSMITH_GEMINI_MODEL)) {
        return { valid: false, error: 'MEMSMITH_GEMINI_MODEL must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-flash-preview' };
      }
    }

    if (settings.MEMSMITH_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.MEMSMITH_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'MEMSMITH_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    if (settings.MEMSMITH_WORKER_PORT) {
      const port = parseInt(settings.MEMSMITH_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'MEMSMITH_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    if (settings.MEMSMITH_WORKER_HOST) {
      const host = settings.MEMSMITH_WORKER_HOST;
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'MEMSMITH_WORKER_HOST must be a valid IP address (e.g., 127.0.0.1, 0.0.0.0)' };
      }
    }

    if (settings.MEMSMITH_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.MEMSMITH_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'MEMSMITH_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    if (settings.MEMSMITH_PYTHON_VERSION) {
      const pythonVersionRegex = /^3\.\d{1,2}$/;
      if (!pythonVersionRegex.test(settings.MEMSMITH_PYTHON_VERSION)) {
        return { valid: false, error: 'MEMSMITH_PYTHON_VERSION must be in format "3.X" or "3.XX" (e.g., "3.13")' };
      }
    }

    const booleanSettings = [
      'MEMSMITH_CONTEXT_SHOW_READ_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_WORK_TOKENS',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT',
      'MEMSMITH_CONTEXT_SHOW_LAST_SUMMARY',
      'MEMSMITH_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    if (settings.MEMSMITH_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.MEMSMITH_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'MEMSMITH_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    if (settings.MEMSMITH_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.MEMSMITH_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'MEMSMITH_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    if (settings.MEMSMITH_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.MEMSMITH_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'MEMSMITH_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    if (settings.MEMSMITH_OPENROUTER_SITE_URL) {
      try {
        new URL(settings.MEMSMITH_OPENROUTER_SITE_URL);
      } catch (error) {
        logger.debug('SETTINGS', 'Invalid URL format', { url: settings.MEMSMITH_OPENROUTER_SITE_URL, error: error instanceof Error ? error.message : String(error) });
        return { valid: false, error: 'MEMSMITH_OPENROUTER_SITE_URL must be a valid URL' };
      }
    }

    return { valid: true };
  }

  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
