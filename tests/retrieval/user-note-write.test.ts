import { describe, it, expect } from 'bun:test';
import { buildUserNoteRequest } from '../../src/services/retrieval/user-note-write';

describe('buildUserNoteRequest', () => {
  it('forces kind=user_note and metadata.userDirected=true', () => {
    const req = buildUserNoteRequest('a note', { projectId: 'p1' });
    expect(req.kind).toBe('user_note');
    expect(req.metadata).toEqual({ userDirected: true });
    expect(req.content).toBe('a note');
    expect(req.projectId).toBe('p1');
  });

  it('overrides caller-supplied metadata.userDirected=false and merges other keys', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1', metadata: { userDirected: false, topic: 'x' } });
    expect(req.metadata).toEqual({ topic: 'x', userDirected: true });
  });

  it('preserves idempotencyKey when given', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1', idempotencyKey: 'k1' });
    expect(req.idempotencyKey).toBe('k1');
  });

  it('omits idempotencyKey when not given', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1' });
    expect('idempotencyKey' in req).toBe(false);
  });
});
