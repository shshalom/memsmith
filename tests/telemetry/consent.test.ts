import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveTelemetryConsent,
  explainTelemetryConsent,
  loadTelemetryConfig,
  saveTelemetryConfig,
  getOrCreateInstallId,
  type TelemetryConfig,
} from '../../src/services/telemetry/consent';

const enabledConfig: TelemetryConfig = {
  enabled: true,
  installId: '00000000-0000-4000-8000-000000000000',
  decidedAt: '2026-06-09T00:00:00.000Z',
};

const disabledConfig: TelemetryConfig = {
  enabled: false,
  installId: '00000000-0000-4000-8000-000000000001',
  decidedAt: '2026-06-09T00:00:00.000Z',
};

describe('resolveTelemetryConsent', () => {
  it('defaults to on (opt-out) with null config and empty env', () => {
    expect(resolveTelemetryConsent({}, null)).toBe(true);
  });

  it('a config without an enabled decision falls through to the default (on)', () => {
    const undecided: TelemetryConfig = {
      installId: '00000000-0000-4000-8000-000000000002',
      decidedAt: '',
    };
    expect(resolveTelemetryConsent({}, undecided)).toBe(true);
    expect(explainTelemetryConsent({}, undecided)).toEqual({ enabled: true, source: 'default' });
  });

  it('DO_NOT_TRACK=1 beats an enabled config', () => {
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: '1' }, enabledConfig)).toBe(false);
  });

  it('DO_NOT_TRACK beats MEMSMITH_TELEMETRY=1', () => {
    expect(
      resolveTelemetryConsent({ DO_NOT_TRACK: '1', MEMSMITH_TELEMETRY: '1' }, enabledConfig)
    ).toBe(false);
  });

  it('any non-empty DO_NOT_TRACK value other than 0/false disables', () => {
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: 'true' }, enabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: 'yes' }, enabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: 'anything' }, enabledConfig)).toBe(false);
  });

  it('DO_NOT_TRACK=0 does not disable', () => {
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: '0' }, enabledConfig)).toBe(true);
  });

  it('DO_NOT_TRACK=false does not disable', () => {
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: 'false' }, enabledConfig)).toBe(true);
  });

  it('empty-string DO_NOT_TRACK counts as not set', () => {
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: '' }, enabledConfig)).toBe(true);
    expect(resolveTelemetryConsent({ DO_NOT_TRACK: '' }, disabledConfig)).toBe(false);
  });

  it('MEMSMITH_TELEMETRY=0 beats an enabled config', () => {
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: '0' }, enabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'false' }, enabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'off' }, enabledConfig)).toBe(false);
  });

  it('MEMSMITH_TELEMETRY=1 enables without any config', () => {
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: '1' }, null)).toBe(true);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'true' }, null)).toBe(true);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'on' }, null)).toBe(true);
  });

  it('MEMSMITH_TELEMETRY=1 beats a disabled config', () => {
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: '1' }, disabledConfig)).toBe(true);
  });

  it('MEMSMITH_TELEMETRY values are case-insensitive', () => {
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'OFF' }, enabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'ON' }, null)).toBe(true);
  });

  it('unrecognized MEMSMITH_TELEMETRY values fall through to config', () => {
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'maybe' }, disabledConfig)).toBe(false);
    expect(resolveTelemetryConsent({ MEMSMITH_TELEMETRY: 'maybe' }, null)).toBe(true);
  });

  it('config enabled=true enables with empty env', () => {
    expect(resolveTelemetryConsent({}, enabledConfig)).toBe(true);
  });

  it('config enabled=false stays off', () => {
    expect(resolveTelemetryConsent({}, disabledConfig)).toBe(false);
  });
});

describe('explainTelemetryConsent', () => {
  it('attributes DO_NOT_TRACK as the deciding layer', () => {
    expect(explainTelemetryConsent({ DO_NOT_TRACK: '1' }, enabledConfig)).toEqual({
      enabled: false,
      source: 'DO_NOT_TRACK',
    });
  });

  it('DO_NOT_TRACK wins over an enabling env override', () => {
    expect(
      explainTelemetryConsent({ DO_NOT_TRACK: '1', MEMSMITH_TELEMETRY: '1' }, enabledConfig)
    ).toEqual({ enabled: false, source: 'DO_NOT_TRACK' });
  });

  it('attributes MEMSMITH_TELEMETRY to the env layer (off)', () => {
    expect(explainTelemetryConsent({ MEMSMITH_TELEMETRY: '0' }, enabledConfig)).toEqual({
      enabled: false,
      source: 'env',
    });
  });

  it('attributes MEMSMITH_TELEMETRY to the env layer (on)', () => {
    expect(explainTelemetryConsent({ MEMSMITH_TELEMETRY: 'on' }, null)).toEqual({
      enabled: true,
      source: 'env',
    });
  });

  it('attributes a config decision to the config layer', () => {
    expect(explainTelemetryConsent({}, enabledConfig)).toEqual({
      enabled: true,
      source: 'config',
    });
    expect(explainTelemetryConsent({}, disabledConfig)).toEqual({
      enabled: false,
      source: 'config',
    });
  });

  it('falls back to default-on (opt-out) with no env and no config', () => {
    expect(explainTelemetryConsent({}, null)).toEqual({ enabled: true, source: 'default' });
  });

  it('unrecognized env values fall through to config/default', () => {
    expect(explainTelemetryConsent({ MEMSMITH_TELEMETRY: 'maybe' }, disabledConfig)).toEqual({
      enabled: false,
      source: 'config',
    });
    expect(explainTelemetryConsent({ MEMSMITH_TELEMETRY: 'maybe' }, null)).toEqual({
      enabled: true,
      source: 'default',
    });
  });

  it('agrees with resolveTelemetryConsent for every layer', () => {
    const cases: Array<[NodeJS.ProcessEnv, TelemetryConfig | null]> = [
      [{ DO_NOT_TRACK: '1' }, enabledConfig],
      [{ MEMSMITH_TELEMETRY: '0' }, enabledConfig],
      [{ MEMSMITH_TELEMETRY: '1' }, disabledConfig],
      [{}, enabledConfig],
      [{}, disabledConfig],
      [{}, null],
    ];
    for (const [env, config] of cases) {
      expect(explainTelemetryConsent(env, config).enabled).toBe(
        resolveTelemetryConsent(env, config)
      );
    }
  });
});

describe('telemetry config persistence', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `telemetry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousDataDir = process.env.MEMSMITH_DATA_DIR;
    process.env.MEMSMITH_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.MEMSMITH_DATA_DIR;
    } else {
      process.env.MEMSMITH_DATA_DIR = previousDataDir;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadTelemetryConfig', () => {
    it('returns null when telemetry.json does not exist', () => {
      expect(loadTelemetryConfig()).toBeNull();
    });

    it('returns null for corrupt JSON without throwing', () => {
      writeFileSync(join(tempDir, 'telemetry.json'), 'not valid json {{{');

      expect(loadTelemetryConfig()).toBeNull();
    });

    it('returns null for malformed shapes', () => {
      writeFileSync(
        join(tempDir, 'telemetry.json'),
        JSON.stringify({ enabled: 'yes', installId: 'abc' })
      );
      expect(loadTelemetryConfig()).toBeNull();

      writeFileSync(join(tempDir, 'telemetry.json'), JSON.stringify([1, 2, 3]));
      expect(loadTelemetryConfig()).toBeNull();
    });

    it('loads an installId-only config with enabled left undecided', () => {
      writeFileSync(join(tempDir, 'telemetry.json'), JSON.stringify({ installId: 'abc' }));

      const config = loadTelemetryConfig();
      expect(config?.installId).toBe('abc');
      expect(config?.enabled).toBeUndefined();
    });

    it('round-trips a saved config', () => {
      saveTelemetryConfig(enabledConfig);

      expect(loadTelemetryConfig()).toEqual(enabledConfig);
    });
  });

  describe('saveTelemetryConfig', () => {
    it('creates the data dir if missing', () => {
      const nestedDir = join(tempDir, 'nested', 'data-dir');
      process.env.MEMSMITH_DATA_DIR = nestedDir;

      saveTelemetryConfig(disabledConfig);

      expect(existsSync(join(nestedDir, 'telemetry.json'))).toBe(true);
    });

    it('writes pretty-printed JSON', () => {
      saveTelemetryConfig(disabledConfig);

      const raw = readFileSync(join(tempDir, 'telemetry.json'), 'utf-8');
      expect(raw).toContain('\n  "enabled": false');
    });
  });

  describe('getOrCreateInstallId', () => {
    it('generates a UUID and persists it WITHOUT recording a consent decision', () => {
      const id = getOrCreateInstallId();

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const config = loadTelemetryConfig();
      expect(config?.installId).toBe(id);
      expect(config?.enabled).toBeUndefined();
      // The opt-out default must survive the ID bootstrap.
      expect(explainTelemetryConsent({}, config)).toEqual({ enabled: true, source: 'default' });
    });

    it('returns the existing install ID on subsequent calls', () => {
      const first = getOrCreateInstallId();
      const second = getOrCreateInstallId();

      expect(second).toBe(first);
    });

    it('preserves enabled state from an existing config', () => {
      saveTelemetryConfig(enabledConfig);

      const id = getOrCreateInstallId();

      expect(id).toBe(enabledConfig.installId);
      expect(loadTelemetryConfig()?.enabled).toBe(true);
    });
  });
});
