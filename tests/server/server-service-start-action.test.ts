import { describe, it, expect } from 'bun:test';
import { resolveStartAction } from '../../src/server/runtime/ServerService.js';

describe('resolveStartAction', () => {
  it('reuse wins first — running server short-circuits regardless of runtime/daemon', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: true,  hasRunningServer: true })).toBe('reuse');
    expect(resolveStartAction({ wantsDaemon: true,  isLocal: false, hasRunningServer: true })).toBe('reuse');
    expect(resolveStartAction({ wantsDaemon: false, isLocal: false, hasRunningServer: true })).toBe('reuse');
  });

  it('local auto-detaches (no --daemon needed) when nothing is running', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: true, hasRunningServer: false })).toBe('daemon');
  });

  it('explicit --daemon detaches for both runtimes', () => {
    expect(resolveStartAction({ wantsDaemon: true, isLocal: true,  hasRunningServer: false })).toBe('daemon');
    expect(resolveStartAction({ wantsDaemon: true, isLocal: false, hasRunningServer: false })).toBe('daemon');
  });

  it('server-mode bare start stays foreground (unchanged)', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: false, hasRunningServer: false })).toBe('foreground');
  });
});
