// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { fetchSettings, patchSettings } from '../../src/ui/viewer/utils/settingsData.js';

// Snapshot real fetch BEFORE any test mutates globalThis.fetch, and restore
// after each test. globalThis.fetch replacement is process-global and leaks
// into subsequent test files (e.g. request-id.test.ts, openclaw/index.test.ts)
// which make real HTTP calls and break when fetch is still mocked.
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe('settingsData', () => {
  it('fetchSettings returns the settings map', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ settings: { tiering: { value: true, source: 'default', boot: false, type: 'boolean', label: 'x', description: 'y' } } }), { status: 200 })) as any;
    const s = await fetchSettings();
    expect(s.tiering.value).toBe(true);
  });

  it('fetchSettings returns {} on error', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); }) as any;
    expect(await fetchSettings()).toEqual({});
  });

  it('patchSettings surfaces confirmationRequired', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ confirmationRequired: true, message: 'metered' }), { status: 200 })) as any;
    const r = await patchSettings({ provider: 'claude' });
    expect(r.confirmationRequired).toBe(true);
  });

  it('patchSettings surfaces a 400 error body', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'MissingProviderKey', message: 'need key' }), { status: 400 })) as any;
    const r = await patchSettings({ provider: 'claude' });
    expect(r.error).toBe('MissingProviderKey');
  });
});
