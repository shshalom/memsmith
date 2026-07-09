// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, mock } from 'bun:test';
import { fetchSettings, patchSettings } from '../../src/ui/viewer/utils/settingsData.js';

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
