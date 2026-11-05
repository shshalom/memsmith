import { describe, it, expect } from 'bun:test';
import {
  applyStartAtLogin,
  startAtLoginDecision,
} from '../../src/npx-cli/install/start-at-login.js';

describe('startAtLoginDecision', () => {
  const base = { interactive: true, ci: false, runtime: 'local' as const };

  it('asks when interactive on local runtime without a flag', () => {
    expect(startAtLoginDecision(base)).toBe('ask');
  });
  it('--start-at-login enables without asking, even non-interactive', () => {
    expect(startAtLoginDecision({ ...base, interactive: false, flag: true })).toBe('enable');
    expect(startAtLoginDecision({ ...base, flag: true })).toBe('enable');
  });
  it('--no-start-at-login skips', () => {
    expect(startAtLoginDecision({ ...base, flag: false })).toBe('skip');
  });
  it('non-interactive without a flag skips', () => {
    expect(startAtLoginDecision({ ...base, interactive: false })).toBe('skip');
  });
  it('server runtime skips', () => {
    expect(startAtLoginDecision({ ...base, runtime: 'server' })).toBe('skip');
    expect(startAtLoginDecision({ ...base, runtime: 'server', flag: true })).toBe('skip');
  });
  it('CI skips unless --start-at-login', () => {
    expect(startAtLoginDecision({ ...base, ci: true })).toBe('skip');
    expect(startAtLoginDecision({ ...base, ci: true, flag: true })).toBe('enable');
  });
});

describe('applyStartAtLogin', () => {
  function io(o: { ok?: boolean; throws?: boolean; answer?: boolean } = {}) {
    const calls: string[] = [];
    const warnings: string[] = [];
    return {
      calls,
      warnings,
      io: {
        ask: async () => { calls.push('ask'); return o.answer ?? true; },
        enable: () => {
          calls.push('enable');
          if (o.throws) throw new Error('boom');
          return { ok: o.ok ?? true, message: o.ok === false ? 'launchctl bootstrap failed: nope' : 'MemSmith starts when you log in.' };
        },
        info: (line: string) => calls.push(`info:${line}`),
        warn: (line: string) => warnings.push(line),
      },
    };
  }

  it('asks, then enables on yes', async () => {
    const t = io();
    await applyStartAtLogin('ask', t.io);
    expect(t.calls).toEqual(['ask', 'enable', 'info:MemSmith starts when you log in.']);
  });
  it('does not enable when the answer is no', async () => {
    for (const answer of [false]) {
      const t = io({ answer });
      await applyStartAtLogin('ask', t.io);
      expect(t.calls).toEqual(['ask']);
    }
  });
  it('enable never asks', async () => {
    const t = io();
    await applyStartAtLogin('enable', t.io);
    expect(t.calls[0]).toBe('enable');
  });
  it('skip does nothing', async () => {
    const t = io();
    await applyStartAtLogin('skip', t.io);
    expect(t.calls).toEqual([]);
  });
  it('a failing enable becomes a warning and the install still succeeds', async () => {
    const t = io({ ok: false });
    await applyStartAtLogin('enable', t.io);
    expect(t.warnings).toEqual(['launchctl bootstrap failed: nope']);
  });
  it('a throwing enable becomes a warning', async () => {
    const t = io({ throws: true });
    await applyStartAtLogin('enable', t.io);
    expect(t.warnings[0]).toContain('boom');
  });
});
