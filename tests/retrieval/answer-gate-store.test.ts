import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AnswerGateStore } from '../../src/services/retrieval/answer-gate-store.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'ms-answer-gate-'));

describe('AnswerGateStore', () => {
  it('reports no pending request before any turn is recorded', () => {
    expect(new AnswerGateStore('s1', freshDir()).isUnsatisfied()).toBe(false);
  });

  it('a new info-request turn is pending and unsatisfied', () => {
    const s = new AnswerGateStore('s1', freshDir());
    s.beginTurn({ pending: true, topic: 'queue engine inline' });
    expect(s.isUnsatisfied()).toBe(true);
    expect(s.read()?.topic).toBe('queue engine inline');
  });

  it('a memory read satisfies the pending request', () => {
    const s = new AnswerGateStore('s1', freshDir());
    s.beginTurn({ pending: true, topic: 't' });
    s.markSatisfied();
    expect(s.isUnsatisfied()).toBe(false);
  });

  it('a block clears the request so the turn is never blocked twice', () => {
    const s = new AnswerGateStore('s1', freshDir());
    s.beginTurn({ pending: true, topic: 't' });
    s.markBlocked();
    expect(s.isUnsatisfied()).toBe(false);
  });

  it('a later non-info turn clears a stale pending request', () => {
    const dir = freshDir();
    new AnswerGateStore('s1', dir).beginTurn({ pending: true, topic: 't' });
    new AnswerGateStore('s1', dir).beginTurn({ pending: false, topic: '' });
    expect(new AnswerGateStore('s1', dir).isUnsatisfied()).toBe(false);
  });

  it('keeps sessions apart', () => {
    const dir = freshDir();
    new AnswerGateStore('a', dir).beginTurn({ pending: true, topic: 't' });
    expect(new AnswerGateStore('b', dir).isUnsatisfied()).toBe(false);
  });

  it('treats a corrupt file as nothing pending', () => {
    const dir = freshDir();
    mkdirSync(join(dir, 's1'), { recursive: true });
    writeFileSync(join(dir, 's1', 'answer-gate.json'), '{not json');
    expect(new AnswerGateStore('s1', dir).isUnsatisfied()).toBe(false);
  });

  it('does not escape the base dir for an odd session id', () => {
    const dir = freshDir();
    const s = new AnswerGateStore('../../etc/x', dir);
    s.beginTurn({ pending: true, topic: 't' });
    expect(s.isUnsatisfied()).toBe(true);
  });
});
