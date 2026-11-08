import { describe, it, expect } from 'bun:test';
import { movedJobsAdvice } from '../../src/npx-cli/commands/projects.js';

// The server requeues at most 500 queued jobs per project database at each
// startup, so one restart does not finish a larger move.
describe('movedJobsAdvice', () => {
  it('says nothing when no job moved', () => {
    expect(movedJobsAdvice(0)).toEqual([]);
  });

  it('asks for one restart up to 500 jobs', () => {
    expect(movedJobsAdvice(1)).toEqual(['Run `memsmith restart` to process the moved jobs.']);
    expect(movedJobsAdvice(500)).toEqual(['Run `memsmith restart` to process the moved jobs.']);
  });

  it('gives the number of restarts beyond 500 jobs', () => {
    const advice = movedJobsAdvice(1200).join(' ');
    expect(advice).toContain('Run `memsmith restart` to process the moved jobs.');
    expect(advice).toContain('at most 500');
    expect(advice).toContain('1200 moved jobs');
    expect(advice).toContain('restart 3 times');
    expect(movedJobsAdvice(501).join(' ')).toContain('restart 2 times');
  });
});
