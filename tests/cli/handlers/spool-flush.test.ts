// SPDX-License-Identifier: Apache-2.0
//
// A spool nobody drains is just a slower way to lose the data. This is the other
// half: on session start, deliver whatever capture had to buffer while the
// server was unreachable.
//
// The ordering rule is load-bearing. The spool is only cleared AFTER delivery
// succeeds — clearing first, or on partial success, would lose exactly the
// events this exists to protect. When in doubt the spool is kept and replayed:
// delivery is idempotent by source id, so a duplicate is harmless while a
// deletion is not.
import { describe, it, expect } from 'bun:test';
import { flushSpooledEvents } from '../../../src/cli/handlers/spool-flush.js';

function deps(over: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const calls: string[] = [];
  return {
    sent,
    calls,
    d: {
      read: () => { calls.push('read'); return [{ id: 'a' }, { id: 'b' }]; },
      send: async (e: unknown) => { calls.push('send'); sent.push(e); },
      clear: () => { calls.push('clear'); },
      projectId: 'p1',
      ...over,
    } as never,
  };
}

describe('flushSpooledEvents', () => {
  it('delivers every spooled event and then clears the spool', async () => {
    const h = deps();
    const r = await flushSpooledEvents(h.d);
    expect(r).toEqual({ delivered: 2, failed: 0 });
    expect(h.sent).toHaveLength(2);
    expect(h.calls[h.calls.length - 1]).toBe('clear');
  });

  it('does nothing when the spool is empty', async () => {
    const h = deps({ read: () => [] });
    expect(await flushSpooledEvents(h.d)).toEqual({ delivered: 0, failed: 0 });
    expect(h.calls).not.toContain('clear');
  });

  it('KEEPS the spool when any delivery fails', async () => {
    // Clearing on partial success would lose the undelivered events — the exact
    // failure this whole mechanism exists to prevent.
    const h = deps({
      send: async (e: { id: string }) => { if (e.id === 'b') throw new Error('server down'); },
    });
    const r = await flushSpooledEvents(h.d);
    expect(r.failed).toBe(1);
    expect(h.calls).not.toContain('clear');
  });

  it('keeps the spool when the server is entirely unreachable', async () => {
    const h = deps({ send: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await flushSpooledEvents(h.d);
    expect(r).toEqual({ delivered: 0, failed: 2 });
    expect(h.calls).not.toContain('clear');
  });

  it('stamps events that were spooled before a project was known', async () => {
    // Cold-boot drops have projectId null: the marker did not exist yet. On
    // replay the project IS known, so the event can finally be attributed
    // instead of being discarded as unroutable.
    const h = deps({ read: () => [{ id: 'a', projectId: null }] });
    await flushSpooledEvents(h.d);
    expect((h.sent[0] as { projectId: string }).projectId).toBe('p1');
  });

  it('does not overwrite a projectId the event already carries', async () => {
    const h = deps({ read: () => [{ id: 'a', projectId: 'original' }] });
    await flushSpooledEvents(h.d);
    expect((h.sent[0] as { projectId: string }).projectId).toBe('original');
  });

  it('never throws — session start must not break on a bad spool', async () => {
    const h = deps({ read: () => { throw new Error('unreadable'); } });
    expect(await flushSpooledEvents(h.d)).toEqual({ delivered: 0, failed: 0 });
  });
});
