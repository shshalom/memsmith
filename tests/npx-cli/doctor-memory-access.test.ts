import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'bun:test';
import { collectChecks, type DoctorProbes } from '../../src/npx-cli/commands/doctor.js';

function probes(): DoctorProbes {
  const empty = mkdtempSync(join(tmpdir(), 'ms-doc-mode-'));
  return {
    probeVersion: () => '1.0.0',
    isPluginInstalled: () => true,
    marketplaceDirectory: () => empty,
    installedPluginVersion: () => '13.10.2',
    probeServerHealth: async () => ({ reachable: false }),
    readServerPidFile: () => null,
    verifyPidFileOwnership: () => true,
    isPortInUse: async () => false,
    dataDir: () => empty,
    generation: async () => ({ provider: 'ollama', ollama: 'ready', model: 'qwen2.5:14b', origin: 'http://localhost:11434' }),
  };
}

async function checks(settings: Record<string, string>, env: Record<string, string>) {
  const settingsPath = join(mkdtempSync(join(tmpdir(), 'ms-doc-mode-s-')), 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ MEMSMITH_SERVER_URL: 'http://127.0.0.1:9', ...settings }));
  const { checks } = await collectChecks(false, false, { settingsPath, env }, probes());
  return checks;
}

describe('doctor memory access and disabled hooks', () => {
  it('shows write access and no disabled hooks by default', async () => {
    const rows = await checks({}, {});
    expect(rows.find((c) => c.name === 'Memory access')).toMatchObject({ status: 'ok', detail: 'write (default)' });
    expect(rows.find((c) => c.name === 'Disabled hooks')).toMatchObject({ status: 'ok', detail: 'none' });
  });

  it('shows read access from the environment over settings.json', async () => {
    const rows = await checks({ MEMSMITH_ACCESS: 'write' }, { MEMSMITH_ACCESS: 'read' });
    const access = rows.find((c) => c.name === 'Memory access');
    expect(access?.status).toBe('warn');
    expect(access?.detail).toContain('read (MEMSMITH_ACCESS in the environment)');
  });

  it('lists disabled features and warns about names it does not know', async () => {
    const rows = await checks({ MEMSMITH_HOOKS_DISABLED: 'context, answer-gate, promt-injection' }, {});
    const disabled = rows.find((c) => c.name === 'Disabled hooks');
    expect(disabled?.status).toBe('warn');
    expect(disabled?.detail).toContain('context, answer-gate');
    expect(disabled?.detail).toContain('unknown, ignored: promt-injection');
  });

  it('warns about an unrecognized access value', async () => {
    const rows = await checks({ MEMSMITH_ACCESS: 'reed' }, {});
    const access = rows.find((c) => c.name === 'Memory access');
    expect(access?.status).toBe('warn');
    expect(access?.detail).toContain('"reed" is not read or write');
  });
});
