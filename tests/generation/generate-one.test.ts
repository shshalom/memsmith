// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { generateOne } from '../../src/services/generation/generate-one.js';

// parseAgentXml (src/sdk/parser.ts) -> parseObservationBlocks calls
// ModeManager.getInstance().getActiveMode(), which throws "No mode loaded"
// unless loadMode() has run first. Every consumer test in this codebase
// loads 'code' in beforeEach for this reason (see e.g. server/generation
// test suites); mirrored here so generateOne's parse step doesn't throw for
// a reason unrelated to what these tests are asserting.
beforeEach(() => {
  ModeManager.getInstance().loadMode('code');
});

function fakeProvider(xml: string, opts: { calls?: string[] } = {}) {
  return {
    providerLabel: 'ollama' as const,
    generate: async (ctx: unknown) => { opts.calls?.push('generate'); return { rawText: xml, providerLabel: 'ollama' } as never; },
  };
}

// NOTE: deviates from the brief's literal fixture text. The brief's fixture
// used `<observation type="decision">` (an XML attribute) wrapped in an
// `<observations>` root. The real parser's regex
// (`/<observation>([\s\S]*?)<\/observation>/g` in src/sdk/parser.ts) matches
// only an EXACT `<observation>` open tag with no attributes, and `type` is
// read as a `<type>` CHILD ELEMENT via extractField, not an attribute.
// Verified directly: parseAgentXml on the brief's literal fixture returns
// `{ valid: false }`, which would make test 1 fail on `out.length` for a
// reason having nothing to do with generateOne's correctness. Corrected the
// fixture to the shape the real parser accepts; the assertions are
// unchanged from the brief.
const XML = '<observation><type>decision</type><title>T</title><facts><fact>f1</fact></facts><narrative>n</narrative></observation>';

describe('generateOne', () => {
  it('produces parsed observations with NO pool', async () => {
    const out = await generateOne({
      provider: fakeProvider(XML),
      event: { eventType: 'PostToolUse' },
      projectId: 'p1',
      teamId: 't1',
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.title).toBe('T');
  });

  it('returns an empty array when the provider output cannot be parsed', async () => {
    const out = await generateOne({
      provider: fakeProvider('not xml'),
      event: {},
      projectId: 'p1',
      teamId: 't1',
    });
    expect(out).toEqual([]);
  });

  it('propagates a provider throw rather than swallowing it (caller keeps the event queued)', async () => {
    const boom = { providerLabel: 'ollama' as const, generate: async () => { throw new Error('ollama down'); } };
    await expect(generateOne({ provider: boom, event: {}, projectId: 'p1', teamId: 't1' })).rejects.toThrow('ollama down');
  });
});
