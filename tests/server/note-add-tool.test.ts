import { describe, it, expect } from 'bun:test';
import { buildUserNoteRequest } from '../../src/services/retrieval/user-note-write';

// note_add's guarantee is delegated to buildUserNoteRequest; this test locks in
// that the tool's write shape carries the forced tags and only exposes content+projectId.
describe('note_add write shape', () => {
  it('produces a user_note/userDirected request from content alone', () => {
    const req = buildUserNoteRequest('composed note', { projectId: 'proj-x' });
    expect(req.kind).toBe('user_note');
    expect(req.metadata).toEqual({ userDirected: true });
    expect(req.content).toBe('composed note');
    expect(req.projectId).toBe('proj-x');
  });
});
