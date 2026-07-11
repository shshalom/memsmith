// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { parseWorkerServiceCommand } from '../../src/services/worker-service.js';

describe('parseWorkerServiceCommand local', () => {
  it('maps local start', () => {
    expect(parseWorkerServiceCommand(['local', 'start'])).toEqual({ command: 'local-start', args: [] });
  });
  it('maps local stop', () => {
    expect(parseWorkerServiceCommand(['local', 'stop'])).toEqual({ command: 'local-stop', args: [] });
  });
  it('unknown local subcommand → local-help', () => {
    expect(parseWorkerServiceCommand(['local', 'wat'])).toEqual({ command: 'local-help', args: [] });
  });
});
