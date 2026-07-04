// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';

beforeEach(() => {
  const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
  modeManager.activeMode = {
    observation_types: [{ id: 'decision' }, { id: 'bug' }, { id: 'discovery' }],
    observation_concepts: [],
  };
});

afterEach(() => {
  const modeManager = ModeManager.getInstance() as unknown as { activeMode: unknown };
  modeManager.activeMode = null;
});

describe('parseAgentXml — decision rationale', () => {
  it('parses why, rejected_alternatives, and lifecycle', () => {
    const xml = `
      <observation>
        <type>decision</type>
        <title>Chose Postgres</title>
        <narrative>Picked Postgres for the team store.</narrative>
        <why>Relational fit and pgvector availability.</why>
        <rejected_alternatives>
          <item>MongoDB — weak joins</item>
          <item>SQLite — no team sync</item>
        </rejected_alternatives>
        <lifecycle>resolved</lifecycle>
      </observation>`;
    const result = parseAgentXml(xml, 'corr-1');
    expect(result.valid).toBe(true);
    const obs = result.valid ? result.observations[0] : null;
    expect(obs?.why).toBe('Relational fit and pgvector availability.');
    expect(obs?.rejectedAlternatives).toEqual(['MongoDB — weak joins', 'SQLite — no team sync']);
    expect(obs?.lifecycle).toBe('resolved');
  });

  it('leaves why/rejected undefined when absent (non-decision)', () => {
    const result = parseAgentXml('<observation><type>bug</type><narrative>race in cache</narrative></observation>', 'c2');
    expect(result.valid).toBe(true);
    const obs = result.valid ? result.observations[0] : null;
    expect(obs?.why).toBeUndefined();
    expect(obs?.rejectedAlternatives).toBeUndefined();
  });
});
