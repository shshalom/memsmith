// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { parseLocalCommand } from '../../src/services/local-runtime-cli.js';

describe('parseLocalCommand', () => {
  it('returns null for a non-local command', () => {
    expect(parseLocalCommand('server', 'start', [])).toBeNull();
  });
  it('maps known subcommands to local-<sub>', () => {
    expect(parseLocalCommand('local', 'start', [])).toEqual({ command: 'local-start', args: [] });
    expect(parseLocalCommand('local', 'stop', [])).toEqual({ command: 'local-stop', args: [] });
    expect(parseLocalCommand('local', 'status', [])).toEqual({ command: 'local-status', args: [] });
    expect(parseLocalCommand('local', 'restart', [])).toEqual({ command: 'local-restart', args: [] });
  });
  it('maps an unknown subcommand to local-help', () => {
    expect(parseLocalCommand('local', 'frobnicate', [])).toEqual({ command: 'local-help', args: [] });
  });
});
