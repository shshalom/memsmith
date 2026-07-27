// SPDX-License-Identifier: Apache-2.0
//
// ObservationStream must not fan a project's observations out to every
// subscriber. Before per-project databases this was a latent no-op (one
// project, one stream); once projects are genuinely concurrent it becomes a
// cross-project content leak — the SSE frame carries full observation content.
//
// Scope is taken from the SUBSCRIBER'S authenticated identity, never from
// anything the client sends, mirroring the routing invariant.
import { describe, it, expect } from 'bun:test';
import { ObservationStream } from '../../../../src/server/routes/v1/ObservationStream.js';

const A = { teamId: 'team-a', projectId: 'proj-a' };
const B = { teamId: 'team-b', projectId: 'proj-b' };

function sink() {
  const frames: string[] = [];
  return {
    res: { write: (c: string) => { frames.push(c); }, writableEnded: false },
    frames,
    events: () => frames
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6).trim())),
  };
}

function obsFor(scope: { teamId: string; projectId: string }, content: string) {
  return {
    type: 'new_observation' as const,
    observation: { id: 'o1', ...scope, content },
  };
}

describe('ObservationStream project scoping', () => {
  it("does not deliver project B's observation to a project A subscriber", () => {
    const stream = new ObservationStream();
    const a = sink();
    stream.subscribe(a.res, A);

    stream.publish(obsFor(B, 'SECRET-FROM-B'));

    expect(a.frames.join('')).not.toContain('SECRET-FROM-B');
    expect(a.events()).toHaveLength(0);
  });

  it("delivers a project's own observation to its subscriber", () => {
    const stream = new ObservationStream();
    const a = sink();
    stream.subscribe(a.res, A);

    stream.publish(obsFor(A, 'MINE'));

    expect(a.events()).toHaveLength(1);
    expect(a.frames.join('')).toContain('MINE');
  });

  it('routes each of two concurrent subscribers only its own project', () => {
    const stream = new ObservationStream();
    const a = sink();
    const b = sink();
    stream.subscribe(a.res, A);
    stream.subscribe(b.res, B);

    stream.publish(obsFor(A, 'FOR-A'));
    stream.publish(obsFor(B, 'FOR-B'));

    expect(a.frames.join('')).toContain('FOR-A');
    expect(a.frames.join('')).not.toContain('FOR-B');
    expect(b.frames.join('')).toContain('FOR-B');
    expect(b.frames.join('')).not.toContain('FOR-A');
  });

  it('does not leak across projects that share a team', () => {
    const stream = new ObservationStream();
    const a = sink();
    stream.subscribe(a.res, { teamId: 'shared', projectId: 'proj-a' });

    stream.publish(obsFor({ teamId: 'shared', projectId: 'proj-b' }, 'OTHER-PROJECT'));

    expect(a.frames.join('')).not.toContain('OTHER-PROJECT');
  });

  it('withholds an unscoped event rather than broadcasting it', () => {
    // An observation with no project cannot be shown to belong to the
    // subscriber, so it must not be delivered. Fail closed, not open.
    const stream = new ObservationStream();
    const a = sink();
    stream.subscribe(a.res, A);

    stream.publish({ type: 'new_observation', observation: { id: 'x', content: 'UNSCOPED' } });

    expect(a.frames.join('')).not.toContain('UNSCOPED');
  });

  it('still drops a broken subscriber without throwing into the publisher', () => {
    const stream = new ObservationStream();
    const boom = { write: () => { throw new Error('socket gone'); }, writableEnded: false };
    stream.subscribe(boom, A);
    const ok = sink();
    stream.subscribe(ok.res, A);

    expect(() => stream.publish(obsFor(A, 'STILL-DELIVERED'))).not.toThrow();
    expect(ok.frames.join('')).toContain('STILL-DELIVERED');
    // the broken one is evicted, so a second publish reaches only the good sink
    expect(() => stream.publish(obsFor(A, 'SECOND'))).not.toThrow();
  });
});
