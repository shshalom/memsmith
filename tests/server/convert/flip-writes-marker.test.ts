import { describe, it, expect } from 'bun:test';
import { flipToTeam } from '../../../src/server/convert/flip-to-team.js';

describe('flipToTeam', () => {
  it('writes the project marker runtime=server + serverUrl and stores key by teamId; no global settings write', () => {
    const calls: any = { marker: null, key: null, global: 0 };
    flipToTeam({
      writeProjectRuntime: (cwd, r) => { calls.marker = { cwd, ...r }; },
      storeKeyForTeam: (teamId, key) => { calls.key = { teamId, key }; },
      writeGlobalSettings: () => { calls.global++; },
    }, { cwd: '/proj/b', teamId: 'team-b', serverUrl: 'http://team-b:38890', apiKey: 'cmem_k' });
    expect(calls.marker).toEqual({ cwd: '/proj/b', runtime: 'server', serverUrl: 'http://team-b:38890' });
    expect(calls.key).toEqual({ teamId: 'team-b', key: 'cmem_k' });
    expect(calls.global).toBe(0);
  });
});
