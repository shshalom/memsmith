import { describe, test, expect } from 'bun:test';
import { toKpis, toKanbanColumns, toDecisionChains } from '../../src/ui/viewer/utils/dashboardShape.js';

const board = { open: [{ id:'a', content:'A' }], blocked: [], deferred: [],
  resolved: [{ id:'b', content:'B' }], active: [], superseded: [] };
const cost = { discoveryTokens: 85000, estUsd: 0.42 };
const decisions = [{ head: { id:'d1', content:'Postgres over SQLite', metadata:{ why:'multi-writer' } }, history: [] }];

describe('dashboardShape', () => {
  test('toKpis counts by lifecycle + usd', () => {
    const k = toKpis(board, cost);
    expect(k.open).toBe(1); expect(k.resolved).toBe(1); expect(k.blocked).toBe(0); expect(k.usd).toBeCloseTo(0.42);
  });
  test('toKanbanColumns yields a column per state with items', () => {
    const cols = toKanbanColumns(board);
    const open = cols.find(c => c.state === 'open');
    expect(open?.items[0].id).toBe('a');
  });
  test('toDecisionChains preserves head + history with why', () => {
    const chains = toDecisionChains(decisions);
    expect(chains[0].head.id).toBe('d1');
    expect(chains[0].head.why).toBe('multi-writer');
    expect(chains[0].history).toEqual([]);
  });
});
