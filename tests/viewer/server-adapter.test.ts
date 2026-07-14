import { describe, test, expect } from 'bun:test';
import { adaptObservation } from '../../src/ui/viewer/utils/serverAdapter.js';

const row = {
  id: 'obs-1', projectId: 'p1', teamId: 't1', serverSessionId: null, kind: 'decision',
  content: 'Postgres Chosen Over SQLite\n\nconcurrent writers + pgvector',
  metadata: { title: 'Postgres Chosen Over SQLite', subtitle: 'over SQLite',
    facts: ['concurrent writers', 'pgvector'], narrative: 'The decision...', why: 'need multi-writer' },
  obsType: 'decision', lifecycleState: 'resolved', createdAtEpoch: 1783519301000, updatedAtEpoch: 1783519301000,
};

describe('adaptObservation', () => {
  test('maps obsType->type, metadata fields, lifecycle', () => {
    const o = adaptObservation(row as any);
    expect(o.type).toBe('decision');
    expect(o.title).toBe('Postgres Chosen Over SQLite');
    expect(o.subtitle).toBe('over SQLite');
    expect(o.narrative).toBe('The decision...');
    // facts array serialized to the viewer's string field
    expect(typeof o.facts).toBe('string');
    expect(o.facts).toContain('concurrent writers');
    expect(o.project).toBe('p1');
    expect(o.created_at_epoch).toBe(1783519301000);
    expect((o as any).lifecycle ?? (o as any).lifecycleState).toBe('resolved');
  });
  test('missing metadata degrades gracefully (derives title from content), never throws', () => {
    const bare = { id: 'x', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: 'body line one\nrest', metadata: {}, createdAtEpoch: 1, updatedAtEpoch: 1 };
    expect(() => adaptObservation(bare as any)).not.toThrow();
    const o = adaptObservation(bare as any);
    expect(o.text).toBe('body line one\nrest');            // content preserved
    expect(o.title).toBe('body line one');                  // title derived from first line
  });

  test('empty content with no metadata yields a null/empty title', () => {
    const empty = { id: 'y', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: '', metadata: {}, createdAtEpoch: 1, updatedAtEpoch: 1 };
    const o = adaptObservation(empty as any);
    expect(o.title === null || o.title === '').toBeTruthy(); // no content -> no derived title
  });
  test('malformed metadata (wrong types) never throws', () => {
    const bad = { id: 'x', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: 'c', metadata: { title: 42, facts: 'not-array', why: {} }, createdAtEpoch: 1, updatedAtEpoch: 1 };
    expect(() => adaptObservation(bad as any)).not.toThrow();
    expect(typeof adaptObservation(bad as any).facts === 'string' || adaptObservation(bad as any).facts === null).toBeTruthy();
  });
});
