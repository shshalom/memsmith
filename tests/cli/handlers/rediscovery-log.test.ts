import { describe, it, expect } from 'bun:test';
import { shouldLogRediscovery } from '../../../src/cli/handlers/observation.js';
const deps = (rows: any[]) => ({ fetchTeamMemory: async () => rows });
describe('shouldLogRediscovery', () => {
  it('flags when enabled + gated + configured + memory held a match', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'PaymentService retries', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'PaymentService' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(true);
    expect(r.matchedIds).toContain('o1');
  });
  it('does not flag when disabled (default)', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'x', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: false, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(false);
  });
  it('does not flag when not gated', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'x', metadata: {} }]),
      { toolName: 'TodoWrite', toolInput: { pattern: 'x' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(false);
  });
  it('does not flag when bridge unconfigured', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'x', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: '', apiKey: '' });
    expect(r.rediscovered).toBe(false);
  });
  it('never throws when fetch rejects', async () => {
    const r = await shouldLogRediscovery({ fetchTeamMemory: async () => { throw new Error('x'); } },
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(false);
  });
});
