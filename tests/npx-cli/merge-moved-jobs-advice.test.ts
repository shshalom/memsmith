import { describe, it, expect } from 'bun:test';
import { mergeFailure, movedJobsAdvice } from '../../src/npx-cli/commands/projects.js';
import { MergeStageError } from '../../src/services/projects/merge.js';
import type { ProjectEntry } from '../../src/services/projects/inventory.js';

// A server that sweeps project queues runs moved jobs on its own; an older one
// requeues at most 500 per project database at each startup. The advice must
// be true for both.
describe('movedJobsAdvice', () => {
  it('says nothing when no job moved', () => {
    expect(movedJobsAdvice(0, 'app')).toEqual([]);
  });

  it('points at the queued count and a restart only if the jobs stay queued', () => {
    const advice = movedJobsAdvice(3, 'app');
    expect(advice).toEqual(['If `memsmith projects` still shows queued generation jobs for app after a few minutes, run `memsmith restart`.']);
    expect(advice.join(' ')).not.toContain('only when it starts');
  });

  it('says a restart handles at most 500 per project beyond 500 jobs', () => {
    expect(movedJobsAdvice(500, 'app')).toHaveLength(1);
    const advice = movedJobsAdvice(1200, 'app').join(' ');
    expect(advice).toContain('at most 500');
    expect(advice).toContain('until `memsmith projects` shows none queued');
    expect(advice).toContain('about 3 restarts for 1200 jobs');
  });
});

describe('mergeFailure at the cancel-jobs step', () => {
  it('says the target may already be processing the jobs and a re-run cancels the source copies', () => {
    const p = (name: string): ProjectEntry => ({ projectId: `p-${name}`, teamId: 't', name, team: 'local', runtime: 'local', folders: [],
      recordedPath: null, databaseName: `msp_${name}`, counts: null, lastActivity: null, flags: [], teamMarkerFolders: [] });
    const text = mergeFailure(new MergeStageError('cancel-jobs', ['backup', 'mark', 'copy'], new Error('connection lost')), p('cli'), p('app')).join(' ');
    expect(text).toContain('may already be processing');
    expect(text).toContain('running the same memsmith merge command again cancels them there');
  });
});
