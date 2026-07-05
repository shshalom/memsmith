// tests/cli/handlers/discovery-gate.test.ts
import { describe, it, expect } from 'bun:test';
import { buildDiscoveryContext } from '../../../src/cli/handlers/discovery-gate.js';

const okDeps = (rows: any[]) => ({ fetchTeamMemory: async () => rows });

describe('buildDiscoveryContext', () => {
  it('returns empty when the tool is not gated', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'x', metadata: {} }]),
      { toolName: 'TodoWrite', toolInput: { pattern: 'x' }, projectName: 'p', gateTools: 'Grep,Glob', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
  it('returns empty when bridge is unconfigured (safe-by-default)', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'auth', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: '', apiKey: '' });
    expect(ctx).toBe('');
  });
  it('returns empty when no memory found', async () => {
    const ctx = await buildDiscoveryContext(okDeps([]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
  it('injects memory when gated + configured + memory found', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'auth uses JWT', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toContain('auth uses JWT');
    expect(ctx).toContain('Relevant team memory');
  });
  it('never throws when the fetch rejects', async () => {
    const throwDeps = { fetchTeamMemory: async () => { throw new Error('boom'); } };
    const ctx = await buildDiscoveryContext(throwDeps,
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
});
